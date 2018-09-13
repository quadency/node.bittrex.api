const bittrex = require('../node.bittrex.api');

bittrex.options({
  stream: true,
  verbose: true,
});

bittrex.getmarkets((response) => {
  if (response.success) {
    const markets = response.result.map(obj => obj.MarketName);

    bittrex.websockets.subscribeOrderBook(markets, (orderbook, deltas) => {
      console.log('USDT-BTC snapshot', JSON.stringify(orderbook['USDT-BTC']));
      console.log('deltas', JSON.stringify(deltas));
    });
  }
});

