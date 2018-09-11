const bittrex = require('../node.bittrex.api');

const apikey = '<ENTER YOUR API KEY>';
const apisecret = '<ENTER YOUR API SECERET>';

bittrex.options({
  apikey,
  apisecret,
  stream: true,
  verbose: true,
});


bittrex.websockets.subscribeBalance(apikey, apisecret, (balance) => {
  console.log('bittrex balance', balance);
});
