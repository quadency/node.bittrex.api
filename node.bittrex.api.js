const request = require('request');
const assign = require('object-assign');
const hmac_sha512 = require('./hmac-sha512.js');
const jsonic = require('jsonic');
const signalR = require('signalr-client');
const cloudscraper = require('cloudscraper');
const zlib = require('zlib');

const NodeBittrexApi = function (givenOptions) {
  let wsclient = null;

  const default_request_options = {
    method: 'GET',
    agent: false,
    headers: {
      'User-Agent': 'Mozilla/4.0 (compatible; Node Bittrex API)',
      'Content-type': 'application/x-www-form-urlencoded',
    },
  };

  const opts = {
    hostname: 'https://bittrex.com/',
    baseUrl: 'https://bittrex.com/api/v1.1',
    baseUrlv2: 'https://bittrex.com/Api/v2.0',
    websockets_baseurl: 'wss://socket.bittrex.com/signalr',
    websockets_hubs: ['CoreHub'],
    apikey: 'APIKEY',
    apisecret: 'APISECRET',
    verbose: false,
    cleartext: false,
    inverse_callback_arguments: false,
    websockets: {
      autoReconnect: true,
    },
    requestTimeoutInSeconds: 15,
  };

  let lastNonces = [];

  const getNonce = function () {
    let nonce = new Date().getTime();

    while (lastNonces.indexOf(nonce) > -1) {
      nonce = new Date().getTime(); // Repetition of the above. This can probably done better :-)
    }

    // keep the last X to try ensure we don't have collisions even if the clock is adjusted
    lastNonces = lastNonces.slice(-50);
    lastNonces.push(nonce);

    return nonce;
  };

  const extractOptions = function (options) {
    Object.keys(options).forEach((key) => {
      opts[key] = options[key];
    });
  };

  if (givenOptions) {
    extractOptions(givenOptions);
  }

  const updateQueryStringParameter = function (uri, key, value) {
    const re = new RegExp(`([?&])${key}=.*?(&|$)`, 'i');
    const separator = uri.indexOf('?') !== -1 ? '&' : '?';

    if (uri.match(re)) {
      return uri.replace(re, `$1${key}=${value}$2`);
    }
    return `${uri + separator + key}=${value}`;
  };

  const setRequestUriGetParams = function (uri, options) {
    let op;
    let updatedUri = uri;
    if (typeof (uri) === 'object') {
      op = uri;
      updatedUri = op.uri;
    } else {
      op = assign({}, default_request_options);
    }

    Object.keys(options).forEach((key) => {
      updatedUri = updateQueryStringParameter(updatedUri, key, options[key]);
    });

    op.headers.apisign = hmac_sha512.HmacSHA512(updatedUri, opts.apisecret); // setting the HMAC hash `apisign` http header
    op.uri = updatedUri;
    op.timeout = opts.requestTimeoutInSeconds * 1000;

    return op;
  };

  const apiCredentials = function (uri) {
    const options = {
      apikey: opts.apikey,
      nonce: getNonce(),
    };

    return setRequestUriGetParams(uri, options);
  };

  const sendRequestCallback = function (callback, op) {
    const start = Date.now();

    request(op, (error, result, body) => {
      ((opts.verbose) ? console.log(`requested from ${op.uri} in: %ds`, (Date.now() - start) / 1000) : '');
      if (!body || !result || result.statusCode !== 200) {
        const errorObj = {
          success: false,
          message: 'URL request error',
          error,
          result,
        };
        return ((opts.inverse_callback_arguments) ?
          callback(errorObj, null) :
          callback(null, errorObj));
      }
      try {
        const resultJson = JSON.parse(body);

        if (!resultJson || !resultJson.success) {
          // error returned by bittrex API - forward the result as an error
          return ((opts.inverse_callback_arguments) ?
            callback(resultJson, null) :
            callback(null, resultJson));
        }
        return ((opts.inverse_callback_arguments) ?
          callback(null, ((opts.cleartext) ? body : resultJson)) :
          callback(((opts.cleartext) ? body : resultJson), null));
      } catch (err) {
        console.error('error parsing body', err);
        const errorObj = {
          success: false,
          message: 'Body parse error',
          error,
          result,
        };
        return ((opts.inverse_callback_arguments) ?
          callback(errorObj, null) :
          callback(null, errorObj));
      }
      if (!result || !result.success) {
        // error returned by bittrex API - forward the result as an error
        return ((opts.inverse_callback_arguments) ?
          callback(result, null) :
          callback(null, result));
      }
      return ((opts.inverse_callback_arguments) ?
        callback(null, ((opts.cleartext) ? body : result)) :
        callback(((opts.cleartext) ? body : result), null));
    });
  };

  const publicApiCall = function (url, callback, options) {
    const op = assign({}, default_request_options);
    if (!options) {
      op.uri = url;
    }
    sendRequestCallback(callback, (!options) ? op : setRequestUriGetParams(url, options));
  };

  const credentialApiCall = function (url, callback, options) {
    if (options) {
      const updateOptions = setRequestUriGetParams(apiCredentials(url), options);
      sendRequestCallback(callback, updateOptions);
      return;
    }
    sendRequestCallback(callback, options);
  };

  let websocketGlobalTickers = false;
  let websocketGlobalTickerCallback;
  let websocketMarkets = [];
  let websocketMarketsCallbacks = [];

  const resetWs = function () {
    websocketGlobalTickers = false;
    websocketGlobalTickerCallback = undefined;
    websocketMarkets = [];
    websocketMarketsCallbacks = [];
  };

  const connectws = function (callback, force) {
    if (wsclient && !force && callback) {
      return callback(wsclient);
    }

    if (force) {
      try {
        wsclient.end();
      } catch (e) {
        console.err('Error ending ws client', e);
      }
    }

    cloudscraper.get(opts.hostname, (cloudscraperError, response) => {
      if (cloudscraperError) {
        console.error('Cloudscraper error occurred');
        console.error(cloudscraperError);
        return;
      }

      opts.headers = {
        cookie: (response.request.headers.cookie || ''),
        user_agent: (response.request.headers['User-Agent'] || ''),
      };

      wsclient = new signalR.client(
        opts.websockets_baseurl,
        opts.websockets_hubs,
        undefined,
        true,
      );

      if (opts.headers) {
        wsclient.headers['User-Agent'] = opts.headers.user_agent;
        wsclient.headers.cookie = opts.headers.cookie;
      }

      wsclient.start();
      wsclient.serviceHandlers = {
        bound() {
          ((opts.verbose) ? console.log('Websocket bound') : '');
          if (opts.websockets && typeof (opts.websockets.onConnect) === 'function') {
            resetWs();
            opts.websockets.onConnect();
          }
        },
        connectFailed(error) {
          ((opts.verbose) ? console.log('Websocket connectFailed: ', error) : '');
        },
        disconnected() {
          console.log('bittrex disconnected basic websocket');
          ((opts.verbose) ? console.log('Websocket disconnected') : '');
          if (opts.websockets && typeof (opts.websockets.onDisconnect) === 'function') {
            opts.websockets.onDisconnect();
          }

          if (
            opts.websockets &&
            (
              opts.websockets.autoReconnect === true ||
              typeof (opts.websockets.autoReconnect) === 'undefined'
            )
          ) {
            ((opts.verbose) ? console.log('Websocket auto reconnecting.') : '');
            wsclient.start(); // ensure we try reconnect
          }
        },
        onerror(error) {
          ((opts.verbose) ? console.log('Websocket onerror: ', error) : '');
        },
        bindingError(error) {
          ((opts.verbose) ? console.log('Websocket bindingError: ', error) : '');
        },
        connectionLost(error) {
          ((opts.verbose) ? console.log('Connection Lost: ', error) : '');
        },
        reconnecting() {
          return true;
        },
        connected() {
          if (websocketGlobalTickers) {
            wsclient.call('CoreHub', 'SubscribeToSummaryDeltas').done((err, result) => {
              if (err) {
                console.error(err);
                return;
              }

              if (result === true) {
                ((opts.verbose) ? console.log('Subscribed to global tickers') : '');
              }
            });
          }

          if (websocketMarkets.length > 0) {
            websocketMarkets.forEach((market) => {
              wsclient.call('CoreHub', 'SubscribeToExchangeDeltas', market).done((err, result) => {
                if (err) {
                  console.error(err);
                  return;
                }

                if (result === true) {
                  ((opts.verbose) ? console.log(`Subscribed to ${market}`) : '');
                }
              });
            });
          }
          ((opts.verbose) ? console.log('Websocket connected') : '');
        },
      };

      if (callback) {
        callback(wsclient);
      }
    }, opts.cloudscraper_headers || {});

    return wsclient;
  };


  const setMessageReceivedWs = function () {
    wsclient.serviceHandlers.messageReceived = function (message) {
      try {
        const data = jsonic(message.utf8Data);
        if (data && data.M) {
          data.M.forEach((M) => {
            if (websocketGlobalTickerCallback) {
              websocketGlobalTickerCallback(M, wsclient);
            }
            if (websocketMarketsCallbacks.length > 0) {
              websocketMarketsCallbacks.forEach((callback) => {
                callback(M, wsclient);
              });
            }
          });
        } else {
          if (websocketGlobalTickerCallback) {
            websocketGlobalTickerCallback({ unhandled_data: data }, wsclient);
          }
          if (websocketMarketsCallbacks.length > 0) {
            websocketMarketsCallbacks.forEach((callback) => {
              callback({ unhandled_data: data }, wsclient);
            });
          }
        }
      } catch (e) {
        ((opts.verbose) ? console.error(e) : '');
      }
      return false;
    };
  };

  const decodeMessage = function (encodedMessage, callback) {
    const raw = Buffer.from(encodedMessage, 'base64');

    zlib.inflateRaw(raw, (err, inflated) => {
      if (err) {
        console.log('Error uncompressing message', err);
        callback(null);
        return;
      }
      callback(JSON.parse(inflated.toString('utf8')));
    });
  };

  // All authenticated ws will be open as separate connections (cause thats our use case)
  const connectAuthenticateWs = function (subscriptionKey, messageCallback) {
    const HUB = 'c2';
    const authenticatedClient = new signalR.client(
      opts.websockets_baseurl,
      [HUB],
      undefined,
      true,
    );

    authenticatedClient.start();
    authenticatedClient.serviceHandlers.connected = function () {
      console.log('Client connected...Now authenticating');
      authenticatedClient.call(HUB, 'GetAuthContext', opts.apikey).done((err, challenge) => {
        const hmacSha512 = hmac_sha512.HmacSHA512(challenge, opts.apisecret);
        const signedChallenge = hmacSha512.toString().toUpperCase().replace('-', '');

        authenticatedClient.call(HUB, 'Authenticate', opts.apikey, signedChallenge).done((authenticateError) => {
          if (authenticateError) {
            console.log('Error authenticating client because:', authenticateError);
            return;
          }
          console.log('Client successfully connected');

          authenticatedClient.on('c2', 'uB', (rawBalance) => {
            decodeMessage(rawBalance, (balance) => {
              if (subscriptionKey === 'uB') {
                messageCallback(balance);
              }
            });
          });

          authenticatedClient.on('c2', 'uO', (rawOrder) => {
            decodeMessage(rawOrder, (order) => {
              if (subscriptionKey === 'uO') {
                messageCallback(order);
              }
            });
          });
        });
      });
    };

    return authenticatedClient.end;
  };


  const orderBookCache = {};
  let lastOrderBookDeltaTime = Date.now();

  const sideReducer = (acc, curr) => {
    acc[curr.R] = curr.Q;
    return acc;
  };

  const initializeOrderBookFor = function (pair, book) {
    if (book) {
      const buys = (book.Z).reduce(sideReducer, {});
      const sells = (book.S).reduce(sideReducer, {});
      orderBookCache[pair] = {
        buys,
        sells,
      };
    } else {
      orderBookCache[pair] = {
        buys: {},
        sells: {},
      };
    }
  };

  const updateSide = function (pair, side, sideDeltas) {
    sideDeltas.forEach((delta) => {
      if (!orderBookCache[pair]) {
        initializeOrderBookFor(pair, null);
        return;
      }
      if (delta.TY === 1) {
        delete orderBookCache[pair][side][delta.R];
        return;
      }
      orderBookCache[pair][side][delta.R] = delta.Q;
    });
  };
  const updateOrderBookCacheWith = function (deltas) {
    const { M: pair, Z: buys, S: sells } = deltas;

    updateSide(pair, 'buys', buys);
    updateSide(pair, 'sells', sells);
  };

  const connectOrderbook = function (markets, callback) {
    const HUB = 'c2';
    const orderBookClient = new signalR.client(
      opts.websockets_baseurl,
      [HUB],
      undefined,
      true,
    );

    orderBookClient.start();
    orderBookClient.serviceHandlers.connected = function () {
      console.log('Client connected...Fetching order book snapshots');
      markets.forEach((market) => {
        orderBookClient.call(HUB, 'QueryExchangeState', market).done((err, response) => {
          if (err) {
            console.error(err);
            return;
          }

          decodeMessage(response, (decodedOrderbook) => {
            initializeOrderBookFor(market, decodedOrderbook);
          });

          orderBookClient.call(HUB, 'SubscribeToExchangeDeltas', market).done((deleteError, isSubscribed) => {
            if (deleteError) {
              console.error(deleteError);
              return;
            }
            console.log(`${market} is subscribed: ${isSubscribed}`);
          });
        });
      });

      orderBookClient.on(HUB, 'uE', (rawDelta) => {
        lastOrderBookDeltaTime = Date.now();
        decodeMessage(rawDelta, (delta) => {
          updateOrderBookCacheWith(delta);
          callback(orderBookCache, delta);
        });
      });
    };
    orderBookClient.serviceHandlers.disconnected = () => {
      console.log('bittrex order book disconnected');
      orderBookClient.start();
    };


    return orderBookClient.end;
  };


  return {
    options(options) {
      extractOptions(options);
    },
    websockets: {
      client(callback, force) {
        return connectws(callback, force);
      },
      listen(callback, force) {
        connectws(() => {
          websocketGlobalTickers = true;
          websocketGlobalTickerCallback = callback;
          setMessageReceivedWs();
        }, force);
      },
      subscribe(markets, callback, force) {
        connectws(() => {
          websocketMarkets = websocketMarkets.concat(markets);
          websocketMarketsCallbacks.push(callback);
          setMessageReceivedWs();
        }, force);
      },
      subscribeBalance(callback) {
        const balanceKey = 'uB';
        return connectAuthenticateWs(balanceKey, callback);
      },
      subscribeOrders(callback) {
        const ordersKey = 'uO';
        return connectAuthenticateWs(ordersKey, callback);
      },
      subscribeOrderBook(markets, callback) {
        return connectOrderbook(markets, callback);
      },
    },
    sendCustomRequest(request_string, callback, credentials) {
      let op;

      if (credentials === true) {
        op = apiCredentials(request_string);
      } else {
        op = assign({}, default_request_options, { uri: request_string });
      }
      sendRequestCallback(callback, op);
    },
    getmarkets(callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarkets`, callback, null);
    },
    getcurrencies(callback) {
      publicApiCall(`${opts.baseUrl}/public/getcurrencies`, callback, null);
    },
    getticker(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getticker`, callback, options);
    },
    getmarketsummaries(callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarketsummaries`, callback, null);
    },
    getmarketsummary(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarketsummary`, callback, options);
    },
    getorderbook(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getorderbook`, callback, options);
    },
    getmarkethistory(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarkethistory`, callback, options);
    },
    getcandles(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetTicks`, callback, options);
    },
    getticks(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetTicks`, callback, options);
    },
    getlatesttick(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetLatestTick`, callback, options);
    },
    buylimit(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/buylimit`, callback, options);
    },
    buymarket(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/buymarket`, callback, options);
    },
    selllimit(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/selllimit`, callback, options);
    },
    tradesell(options, callback) {
      credentialApiCall(`${opts.baseUrlv2}/key/market/TradeSell`, callback, options);
    },
    tradebuy(options, callback) {
      credentialApiCall(`${opts.baseUrlv2}/key/market/TradeBuy`, callback, options);
    },
    sellmarket(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/sellmarket`, callback, options);
    },
    cancel(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/cancel`, callback, options);
    },
    getopenorders(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/getopenorders`, callback, options);
    },
    getbalances(callback) {
      credentialApiCall(`${opts.baseUrl}/account/getbalances`, callback, {});
    },
    getbalance(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getbalance`, callback, options);
    },
    getwithdrawalhistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getwithdrawalhistory`, callback, options);
    },
    getdepositaddress(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getdepositaddress`, callback, options);
    },
    getdeposithistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getdeposithistory`, callback, options);
    },
    getorderhistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getorderhistory`, callback, options || {});
    },
    getorder(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getorder`, callback, options);
    },
    withdraw(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/withdraw`, callback, options);
    },
    getbtcprice(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/currencies/GetBTCPrice`, callback, options);
    },
  };
};

module.exports = NodeBittrexApi();

module.exports.createInstance = NodeBittrexApi;
