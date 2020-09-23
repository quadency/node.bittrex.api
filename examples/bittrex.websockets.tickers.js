const bittrex = require('../node.bittrex.api');

bittrex.options({
  verbose: true,
  websockets: {
    onConnect() {
      bittrex.websockets.subscribeTickers((msg) => {
        console.log(msg);
      });
    },
  },
});

bittrex.websockets.client(() => {
  console.log('starting...');
  setTimeout(() => {
    bittrex.websockets.unsubscribeTickers();
  }, 30000);
});
