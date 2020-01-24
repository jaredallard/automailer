# automailer

automailer automatically scrapes [SimplePractice](https://www.simplepractice.com/) for the latest billing statements
and sends them via [ClickSend](https://clicksend.com) to your insurance provider for easy reimbursement.

## Installation

First modify the `config.example.json` and save it as `config.json`.

Get a reimbursement PDF from your insurance provider, and fill it out. The code assumes it only needs
a signature, support for adding total inseration may come later.

Save that PDF as `template.pdf` in the base of this repo, and look at the `createPDF` method in `index.ts`,
modify the positions as needed.

Now run the code.

```bash
# clone the source code
$ git clone git@github.com:jaredallard/automailer

# install the deps
$ yarn

# install ts-node (a typescript node.js wrapper)
$ yarn global add ts-node

# run the software
$ ts-node src/index.ts
```

Now setup some sort of CRON task, or something to run this.

## License

MIT
