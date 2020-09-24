const bittrex = require('../node.bittrex.api');

const apikey = '<ENTER YOUR API KEY>';
const apisecret = '<ENTER YOUR API SECERET>';

bittrex.options({
  apikey,
  apisecret,
  verbose: true,
  websockets: {
    onConnect() {
      bittrex.websockets.subscribeOrders((msg) => {
        console.log(msg);
      });
    },
  },
});

bittrex.websockets.client(() => {
  console.log('Starting...');
}, true);
