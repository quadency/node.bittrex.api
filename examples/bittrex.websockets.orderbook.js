const bittrex = require('../node.bittrex.api');


bittrex.options({
  stream: true,
  verbose: true,
});


const disconnectedFn = bittrex.websockets.subscribeOrderBook(['USDT-BTC', 'USD-BTC'], (orderbook, deltas) => {
  console.log('snapshots', JSON.stringify(orderbook));
  console.log('deltas', JSON.stringify(deltas));
  // disconnectedFn();
});

