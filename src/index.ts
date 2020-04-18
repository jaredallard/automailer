/**
 * automailer - an automated PDF mailer with customization sorta
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 **/

'use strict';

import * as fs from 'fs-extra'
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as cheerio from 'cheerio'
import * as request from 'request-promise-native'
import * as url from 'url'
import * as clicksend from 'clicksend'

const log = require('pino')()

const mergePDFs = async (pdfsToMerge: Uint8Array[]) => {
  const mergedPdf = await PDFDocument.create();
  for (const pdfCopyDoc of pdfsToMerge) {
    const pdf = await PDFDocument.load(pdfCopyDoc);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => {
      mergedPdf.addPage(page);
    });
  }
  return mergedPdf.save();
}

/**
 * create a PDF file and embed the current date into a position in it.
 * @param path path to pdf file
 */
const createPDF = async (path: string) => {
  const bytes = await fs.readFile(path)
  const pdfDoc = await PDFDocument.load(bytes)
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
  
  const pages = pdfDoc.getPages()
  const firstPage = pages[0]

  // Get the width and height of the first page
  const { width, height } = firstPage.getSize()

  // inserts the date into our document
  // MODIFY THIS IF YOU'RE USING THIS
  const now = new Date()
  const dateStr = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`
  firstPage.drawText(dateStr, {
    x: width - 90,
    y: 80,
    size: 9,
    font: helveticaFont,
  })

  return pdfDoc.save()
}

/**
 * 
 * @param config config object
 * @returns {Uint8Array[]}
 */
const getReimbursementStatement = async (config: any) => {
  const name = url.parse(config.website.url).host.split('.')[0]
  const loginURL = config.website.url+'/client_portal/client_accesses/sign_in'
  const statementURL = config.website.url+'/client-portal-api/billing-items?filter[thisType]=superbill&page[size]=10'
  const statementDownloadURL = config.website.url+'/client-portal-api/billing-items/'
  const clientIDURL = config.website.url+'/client_portal/client_selection'
  const apiHeaders = {
    'api-version': '2019-01-17',
    'application-platform': 'web',
    'application-build-version': '0.0.0+85ec7a61',
  }
  const cookieJar = request.jar()
  cookieJar.setCookie('client-portal-session-expiration_time=86400;', config.website.url)

  log.info('accessing simplepractice', name)
  let resp = await request({
    uri: loginURL,
    resolveWithFullResponse: true
  })

  cookieJar.setCookie(request.cookie(resp.headers['set-cookie'].join(" ")), config.website.url)
  const $ = cheerio.load(resp.body)

  const csrfToken = $('meta[name=csrf-token]').attr('content')
  if (!csrfToken) {
    throw new Error('failed to get csrf-token')
  }
  
  log.info('got crsf token', csrfToken)

  const cpca = config.website.login
  cpca.url_name = name
  resp = await request({
    method: 'POST',
    uri: loginURL,
    resolveWithFullResponse: true,
    jar: cookieJar,
    simple: false,
    form: {
      utf8: '✓',
      client_portal_client_access: cpca,
      authenticity_token: csrfToken,
      commit: 'Log in',
    }
  })
  if (resp.statusCode !== 200 && resp.statusCode !== 302) {
    throw new Error(`failed to auth, got unexpected statusCode: ${resp.statusCode}`)
  }
  cookieJar.setCookie(request.cookie(resp.headers['set-cookie'].join(" ")), config.website.url)

  log.info('getting client_id set')
  resp = await request({
    uri: clientIDURL,
    jar: cookieJar,
    resolveWithFullResponse: true,
  })
  if (resp.statusCode !== 200 && resp.statusCode !== 302) {
    throw new Error(`failed to get client_id set in session, got unexpected statusCode: ${resp.statusCode}`)
  }
  cookieJar.setCookie(request.cookie(resp.headers['set-cookie'].join(" ")), config.website.url)


  log.info('fetching statements')
  const statementResp = await request({
    uri: statementURL,
    jar: cookieJar,
    headers: apiHeaders,
    json: true,
  })
  if (resp.statusCode !== 200 && resp.statusCode !== 302) {
    throw new Error(`failed to get statements, got unexpected statusCode: ${resp.statusCode}`)
  }
  cookieJar.setCookie(request.cookie('ember_simple_auth-redirectTarget=%2Fbilling;'), config.website.url)
  cookieJar.setCookie(request.cookie(resp.headers['set-cookie'].join(" ")), config.website.url)

  log.info(`found ${statementResp.data.length} statements`)

  const lastDateStr = config.state.lastDate || new Date().toISOString()
  const lastDate = Date.parse(lastDateStr)

  const statements = statementResp.data.filter(statement => {
    const createdAt = Date.parse(statement.attributes.createdAt)
    return createdAt > lastDate
  })

  log.info(`found ${statements.length} new statements, last check was ${lastDateStr}`)

  const statementPdfs = []
  for (const statement of statements) {
    const dlURL = statementDownloadURL + encodeURIComponent(statement.attributes.cursorId) + '.pdf'

    log.info('downloading pdf from', dlURL)
    const pdf = await request({
      uri: dlURL,
      jar: cookieJar,
      headers: apiHeaders,
      encoding: null,
    })

    const obj = statement
    obj.pdf = pdf
    statementPdfs.push(obj)
  }

  return statementPdfs
}


const main = async () => {
  const config = require('../config.json')
  const letterAPI = new clicksend.PostLetterApi(config.clicksend.username, config.clicksend.api_key)
  const emailAPI = new clicksend.TransactionalEmailApi(config.clicksend.username, config.clicksend.api_key)
  const uploadAPI = new clicksend.UploadApi(config.clicksend.username, config.clicksend.api_key)
  const returnAddrAPI = new clicksend.PostReturnAddressApi(config.clicksend.username, config.clicksend.api_key)
  const SMSApi = new clicksend.SMSApi(config.clicksend.username, config.clicksend.api_key)

  log.info('fetching latest statements')
  const statements = await getReimbursementStatement(config)

  if (statements.length === 0) {
    log.info('no new statements')
    process.exit()
  }

  for (const statement of statements) {
    const loggerInfo = Object.assign({}, statement)
    delete loggerInfo.pdf
    delete loggerInfo.type
    const childLogger = log.child(loggerInfo)

    try {
      childLogger.info('creating template pdf')
      const pdf = await createPDF('./template.pdf')
    
      childLogger.info('merging pdfs')
      const merged = await mergePDFs([pdf, statement.pdf])
  

      if (config.email.enabled) {
        const email = new clicksend.Email();
        const pdfAttachment = new clicksend.Attachment()


        const from = new clicksend.EmailFrom()
        from.emailAddressId = config.email.from.id
        from.name = config.email.from.name
        
        const to = new clicksend.EmailRecipient()
        to.email = config.email.to.email
        to.name = config.email.to.name

        pdfAttachment.type = 'application/pdf'
        pdfAttachment.content =  Buffer.from(merged).toString('base64')
        pdfAttachment.disposition = 'attachment'
        pdfAttachment.filename = 'statement.pdf'
        email.attachments = [pdfAttachment]
        email.subject = 'New Statement'
        email.body = "A new statement has been generated."
        email.to = [to]
        email.from = from

        childLogger.info('sending email')
        const resp = await emailAPI.emailSendPost(email)
        console.log(resp.body)
      }
    
      if (config.mailing.enabled) {
        childLogger.info('uploading pdf to clicksend')
        const upload = new clicksend.UploadFile()
        upload.content = Buffer.from(merged).toString('base64')
        const uploadResp = await uploadAPI.uploadsPost(upload, 'post')

        childLogger.info('getting return addresse(s)')
        let resp = await returnAddrAPI.postReturnAddressesGet(1, 1)
      
        const returnAddr = resp.body.data.data[0]
        childLogger.info('using return address', returnAddr)
      
        const recp = new clicksend.PostRecipient();
        recp.addressName = config.mailing.name
        recp.addressLine1 = config.mailing.line1
        recp.addressCity = config.mailing.city
        recp.addressState = config.mailing.state
        recp.addressPostalCode = config.mailing.postalCode
        recp.addressCountry = config.mailing.country
        recp.returnAddressId = returnAddr.return_address_id
      
      
        childLogger.info('sending letter to', recp)
        const letter = new clicksend.PostLetter();
        letter.fileUrl = uploadResp.body.data._url
        letter.priorityPost = 0
        // TODO(jaredallard): allow sending yourself a copy
        letter.recipients = [recp]
        letter.templateUsed = 0
        letter.colour = 0
        letter.duplex = 0
      
        childLogger.info('getting letter cost')
        resp = await letterAPI.postLettersPricePost(letter)
        childLogger.info('sending letter will cost', `${resp.body.data._currency.currency_prefix_d}${resp.body.data.total_price}`)
      
        childLogger.info('sending letter')
        resp = await letterAPI.postLettersSendPost(letter)
        console.log(resp.body)
      }
    
      if (config.sms.enabled) {
        childLogger.info('sending notification')
        const smsMessage = new clicksend.SmsMessage();
        smsMessage.to = config.sms.number;
        smsMessage.body = `Hello! Automailer has sent a letter to your insurance company due to a new statement being available.`
        const smsCollection = new clicksend.SmsMessageCollection();
        smsCollection.messages = [smsMessage];
      
        const resp = await SMSApi.smsSendPost(smsCollection)
        console.log(resp)
      }

      childLogger.info('done')
    } catch (err) {
      childLogger.error('failed to process statement:', err.message || err)
      process.exit(1)
    }
  }

  // update the last run date
  config.state.lastDate = new Date().toISOString()

  try {
    await fs.writeFile('./config.json', JSON.stringify(config, null, 2))
  } catch (err) {
    log.error('failed to dump state into config', err.message || err)
    process.exit(1)
  }
}

main()