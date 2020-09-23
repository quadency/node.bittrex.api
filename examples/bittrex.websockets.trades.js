const bittrex = require('../node.bittrex.api');

bittrex.options({
  verbose: true,
  websockets: {
    onConnect() {
      bittrex.websockets.subscribeTrades('BTC-USDT', (msg) => {
        console.log(msg);
      });
    },
  },
});

bittrex.websockets.client(() => {
  console.log('Starting...');
});
