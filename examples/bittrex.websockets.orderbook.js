const bittrex = require('../node.bittrex.api');

bittrex.options({
  verbose: true,
  websockets: {
    onConnect() {
      bittrex.websockets.subscribeOrderBook('BTC-USDT', 500, (msg) => {
        console.log(msg);
      });
    },
  },
});

bittrex.websockets.client(() => {
  console.log('Starting...');
  setTimeout(() => {
    bittrex.websockets.unsubscribeOrderbook('BTC-USDT', 500);
  }, 30000);
});
