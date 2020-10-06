const bittrex = require('../node.bittrex.api');

bittrex.options({
  verbose: true,
  websockets: {
    onConnect() {
      bittrex.websockets.subscribeMarkets((msg) => {
        console.log(msg);
      });
    },
  },
});

bittrex.websockets.client(() => {
  console.log('Starting...');
  setTimeout(() => {
    bittrex.websockets.unsubscribeMarkets();
  }, 30000);
});
