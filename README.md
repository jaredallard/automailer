# automailer

automailer automatically scrapes [SimplePractice](https://www.simplepractice.com/) for the latest billing statements
and sends them via [ClickSend](https://clicksend.com) to your insurance provider for easy reimbursement.

## Installation

First modify the `config.example.json` and save it as `config.json`.

```bash
$ yarn
$ yarn global add ts-node
$ ts-node src/index.ts
```

Now setup some sort of CRON task, or something to run this.

## License

MIT
