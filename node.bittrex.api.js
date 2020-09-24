const request = require('request');
const assign = require('object-assign');
const jsonic = require('jsonic');
const signalR = require('signalr-client');
const cloudscraper = require('cloudscraper');
const zlib = require('zlib');
const hmac_sha512 = require('./hmac-sha512.js');
const uuidv4 = require('./uuidv4');

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
    websockets_baseurlv3: 'wss://socket-v3.bittrex.com/signalr',
    websockets_hubs: ['CoreHub'],
    websockets_hubsv3: ['c3'],
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

  // active only if opts.verbose is true
  const logger = {
    log(msg) {
      if (opts.verbose) {
        console.log(msg);
      }
    },
    error(msg) {
      if (opts.verbose) {
        console.error(msg);
      }
    },
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

  let websocketTickersCallbacks = [];

  const handleTickerMessage = function (message) {
    websocketTickersCallbacks.forEach((callback) => {
      callback(message);
    });
  };

  /*
   * websocketOrderbookCallbacks = {
   *    // markets
   *    BTC-USDT: {
   *      // depths
   *      1: [],
   *      25: [],
   *      500: [],
   *    },
   *  };
   */
  let websocketOrderbookCallbacks = {};

  const handleOrderbookMessage = function (message) {
    const { marketSymbol: market, depth } = message;
    const callbacks = (websocketOrderbookCallbacks[market] && websocketOrderbookCallbacks[market][depth])
      ? websocketOrderbookCallbacks[market][depth]
      : [];
    if (callbacks.length) {
      callbacks.forEach((callback) => {
        callback(message);
      });
    }
  };

  /*
   * websocketTradesCallbacks = {
   *    // markets
   *    BTC-USDT: [],
   * };
   */
  let websocketTradesCallbacks = {};

  const handleTradeMessage = function (message) {
    const { marketSymbol: market } = message;
    const callbacks = websocketTradesCallbacks[market] || [];
    if (callbacks.length) {
      callbacks.forEach((callback) => {
        callback(message);
      });
    }
  };

  let websocketBalanceCallback;

  const handleBalanceMessage = function (message) {
    if (websocketBalanceCallback) {
      websocketBalanceCallback(message);
    }
  };

  let websocketOrderCallback;

  const handleOrderMessage = function (message) {
    if (websocketOrderCallback) {
      websocketOrderCallback(message);
    }
  };

  const handleAuthentication = function (callback) {
    const timestamp = Date.now();
    const uuid = uuidv4();
    const signature = hmac_sha512.HmacSHA512(`${timestamp}${uuid}`, opts.apisecret)
      .toString()
      .replace('-', '');
    wsclient
      .call('c3', 'Authenticate', opts.apikey, timestamp, uuid, signature)
      .done((err, result) => {
        if (err) {
          console.error(err);
          return;
        }
        if (!result.Success) {
          logger.error(`Authentication failed with error code: ${result.ErrorCode}`);
          return;
        }
        logger.log('Authentication successful');
        if (callback && typeof callback === 'function') {
          callback();
        }
      });
  };

  const handleMessage = function (messageType, message) {
    switch (messageType) {
    case 'tickers':
      handleTickerMessage(message);
      break;
    case 'orderBook':
      handleOrderbookMessage(message);
      break;
    case 'trade':
      handleTradeMessage(message);
      break;
    case 'balance':
      handleBalanceMessage(message);
      break;
    case 'order':
      handleOrderMessage(message);
      break;
    case 'authenticationExpiring':
      handleAuthentication();
      break;
    default:
      console.error(`Unrecognized message type: ${messageType}`);
    }
  };

  const resetWs = function () {
    websocketTickersCallbacks = [];
    websocketOrderbookCallbacks = {};
    websocketTradesCallbacks = {};
    websocketBalanceCallback = undefined;
    websocketOrderCallback = undefined;
  };

  const disconnectws = function () {
    if (wsclient) {
      wsclient.end();
    }
  };

  const connectws = function (callback, authenticate, force) {
    if (wsclient && !force && callback) {
      callback(wsclient);
      return disconnectws;
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
        opts.websockets_baseurlv3,
        opts.websockets_hubsv3,
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
          logger.log('Websocket bound');
          if (opts.websockets && typeof (opts.websockets.onConnect) === 'function') {
            resetWs();
            if (authenticate) {
              handleAuthentication(opts.websockets.onConnect);
            } else {
              opts.websockets.onConnect();
            }
          }
        },
        connectFailed(error) {
          logger.error(`Websocket connectFailed: ${error}`);
        },
        disconnected() {
          console.log('bittrex disconnected basic websocket');
          logger.log('Websocket disconnected');
          if (opts.websockets && typeof (opts.websockets.onDisconnect) === 'function') {
            opts.websockets.onDisconnect();
          }

          if (
            opts.websockets &&
            (
              opts.websockets.autoReconnect ||
              typeof (opts.websockets.autoReconnect) === 'undefined'
            )
          ) {
            logger.log('Websocket auto reconnecting.');
            wsclient.start(); // ensure we try reconnect
          }
        },
        onerror(error) {
          logger.error(`Websocket onerror: ${error}`);
        },
        bindingError(error) {
          logger.error(`Websocket bindingError: ${error}`);
        },
        connectionLost(error) {
          logger.error(`Connection Lost: ${error}`);
        },
        reconnecting() {
          return true;
        },
        connected() {
          logger.log('Websocket connected');
        },
        messageReceived(message) {
          try {
            const data = jsonic(message.utf8Data);
            if (data && data.M) {
              data.M.forEach((obj) => {
                if (obj.A.length) {
                  decodeMessage(obj.A[0], (decoded) => {
                    handleMessage(obj.M, decoded);
                  });
                  return;
                }
                handleMessage(obj.M);
              });
            }
          } catch (e) {
            logger.error(e);
          }
        },
      };

      if (callback) {
        callback(wsclient);
      }
    }, opts.cloudscraper_headers || {});

    return disconnectws;
  };

  const subscribe = function (channels, callback) {
    const subscribeChannels = Array.isArray(channels) ? channels : [channels];

    wsclient
      .call('c3', 'subscribe', subscribeChannels)
      .done((err, results) => {
        if (err) {
          console.error(err);
          return;
        }

        if (results) {
          results.forEach((result) => {
            if (!result.Success) {
              logger.error(`Subscribe failed with error code: ${result.ErrorCode}`);
            }
          });
        }
        if (callback && typeof callback === 'function') {
          callback();
        }
      });
  };

  const unsubscribe = function (channels, callback) {
    const unsubscribeChannels = Array.isArray(channels) ? channels : [channels];

    wsclient
      .call('c3', 'unsubscribe', unsubscribeChannels)
      .done((err, results) => {
        if (err) {
          console.error(err);
          return;
        }

        if (results) {
          results.forEach((result) => {
            if (!result.Success) {
              logger.error(`Subscribe failed with error code: ${result.ErrorCode}`);
            }
          });
        }
        if (callback && typeof callback === 'function') {
          callback();
        }
      });
  };

  return {
    options(options) {
      extractOptions(options);
    },
    websockets: {
      client(callback, authenticate, force) {
        return connectws(callback, authenticate, force);
      },
      subscribeTickers(callback) {
        connectws(() => {
          subscribe('tickers', () => {
            websocketTickersCallbacks.push(callback);
          });
        });
      },
      unsubscribeTickers() {
        unsubscribe('tickers', () => {
          websocketTickersCallbacks = [];
        });
      },
      subscribeOrderBook(market, depth, callback) {
        connectws(() => {
          subscribe(`orderbook_${market}_${depth}`, () => {
            if (!websocketOrderbookCallbacks[market]) {
              websocketOrderbookCallbacks[market] = {};
            }
            if (!websocketOrderbookCallbacks[market][depth]) {
              websocketOrderbookCallbacks[market][depth] = [];
            }
            websocketOrderbookCallbacks[market][depth].push(callback);
          });
        });
      },
      unsubscribeOrderbook(market, depth) {
        unsubscribe(`orderbook_${market}_${depth}`, () => {
          if (websocketOrderbookCallbacks[market] && websocketOrderbookCallbacks[market][depth]) {
            delete websocketOrderbookCallbacks[market][depth];
          }
        });
      },
      subscribeTrades(market, callback) {
        connectws(() => {
          subscribe(`trade_${market}`, () => {
            if (!websocketTradesCallbacks[market]) {
              websocketTradesCallbacks[market] = [];
            }
            websocketTradesCallbacks[market].push(callback);
          });
        });
      },
      unsubscribeTrades(market) {
        unsubscribe(`trade_${market}`, () => {
          if (websocketTradesCallbacks[market]) {
            delete websocketTradesCallbacks[market];
          }
        });
      },
      subscribeBalance(callback) {
        connectws(() => {
          subscribe('balance', () => {
            if (!websocketBalanceCallback) {
              websocketBalanceCallback = callback;
            }
          });
        });
      },
      unsubscribeBalance() {
        unsubscribe('balance', () => {
          if (websocketBalanceCallback) {
            websocketBalanceCallback = undefined;
          }
        });
      },
      subscribeOrders(callback) {
        connectws(() => {
          subscribe('order', () => {
            if (!websocketOrderCallback) {
              websocketOrderCallback = callback;
            }
          });
        });
      },
      unsubscribeOrders() {
        unsubscribe('order', () => {
          if (websocketOrderCallback) {
            websocketOrderCallback = undefined;
          }
        });
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
