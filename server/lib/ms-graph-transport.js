'use strict';

const graph = require('@microsoft/microsoft-graph-client');
const identity = require('@azure/identity');
const azure = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const EventEmitter = require('events');

const packageData = require('../package.json');

/**
 * Generates a bunyan-like logger that prints to console
 *
 * @returns {Object} Bunyan logger instance
 */
const createDefaultLogger = (levels) => {
    let levelMaxLen = 0;
    let levelNames = new Map();
    levels.forEach(level => {
        if (level.length > levelMaxLen) {
            levelMaxLen = level.length;
        }
    });

    levels.forEach(level => {
        let levelName = level.toUpperCase();
        if (levelName.length < levelMaxLen) {
            levelName += ' '.repeat(levelMaxLen - levelName.length);
        }
        levelNames.set(level, levelName);
    });

    let print = (level, entry, message, ...args) => {
        let prefix = '';
        if (entry) {
            if (entry.tnx === 'server') {
                prefix = 'S: ';
            } else if (entry.tnx === 'client') {
                prefix = 'C: ';
            }

            if (entry.sid) {
                prefix = '[' + entry.sid + '] ' + prefix;
            }

            if (entry.cid) {
                prefix = '[#' + entry.cid + '] ' + prefix;
            }
        }

        message = util.format(message, ...args);
        message.split(/\r?\n/).forEach(line => {
            console.log('[%s] %s %s', new Date().toISOString().substr(0, 19).replace(/T/, ' '), levelNames.get(level), prefix + line);
        });
    };

    let logger = {};
    levels.forEach(level => {
        logger[level] = print.bind(null, level);
    });

    return logger;
}

const _logFunc = (logger, level, defaults, data, message, ...args) => {
    let entry = {};

    Object.keys(defaults || {}).forEach(key => {
        if (key !== 'level') {
            entry[key] = defaults[key];
        }
    });

    Object.keys(data || {}).forEach(key => {
        if (key !== 'level') {
            entry[key] = data[key];
        }
    });

    logger[level](entry, message, ...args);
};

/**
 * Returns a bunyan-compatible logger interface. Uses either provided logger or
 * creates a default console logger
 *
 * @param {Object} [options] Options object that might include 'logger' value
 * @return {Object} bunyan compatible logger
 */
const getLogger = (options, defaults) => {
    options = options || {};

    let response = {};
    let levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

    if (!options.logger) {
        // use vanity logger
        levels.forEach(level => {
            response[level] = () => false;
        });
        return response;
    }

    let logger = options.logger;

    if (options.logger === true) {
        logger = createDefaultLogger(levels);
    }

    levels.forEach(level => {
        response[level] = (data, message, ...args) => {
            _logFunc(logger, level, defaults, data, message, ...args);
        };
    });

    return response;
}


/**
 * Generates a Transport object for Microsoft Graph
 *
 * Possible options can be the following:
 *
 *  * **sendingRate** optional Number specifying how many messages per second should be delivered to Microsoft Graph
 *  * **maxConnections** optional Number specifying max number of parallel connections to Microsoft Graph
 *
 * @constructor
 * @param {Object} optional config parameter
 */
class GraphTransport extends EventEmitter {
    constructor(options) {
        super();
        options = options || {};

        this.options = options || {};
        this.client = this.initClient();

        this.name = 'MsGraph';
        this.version = packageData.version;

        this.logger = getLogger(this.options, {
            component: this.options.component || 'graph-transport'
        });

        // parallel sending connections
        this.maxConnections = Number(this.options.maxConnections) || Infinity;
        this.connections = 0;

        // max messages per second
        this.sendingRate = Number(this.options.sendingRate) || Infinity;
        this.sendingRateTTL = null;
        this.rateInterval = 1000; // milliseconds
        this.rateMessages = [];

        this.pending = [];

        this.idling = true;

        setImmediate(() => {
            if (this.idling) {
                this.emit('idle');
            }
        });
    }

    /**
     * Initialize Microsoft Graph api client
     */
    initClient() {
        const options = this.options.graph;
        const credentials = new identity.ClientSecretCredential(options.tenantID, options.clientID, options.clientSecret);
        const scopes = options.scopes;
        const authProvider = new azure.TokenCredentialAuthenticationProvider(credentials, { scopes });
        return client = graph.Client.initWithMiddleware({
            debugLogging: ('debug' in options) && options.debug,
            authProvider
        });
    }

    /**
     * Schedules a sending of a message
     *
     * @param {Object} emailMessage MailComposer object
     * @param {Function} callback Callback function to run when the sending is completed
     */
    send(mail, callback) {
        if (this.connections >= this.maxConnections) {
            this.idling = false;
            return this.pending.push({
                mail,
                callback
            });
        }

        if (!this._checkSendingRate()) {
            this.idling = false;
            return this.pending.push({
                mail,
                callback
            });
        }

        this._send(mail, (...args) => {
            setImmediate(() => callback(...args));
            this._sent();
        });
    }

    _checkRatedQueue() {
        if (this.connections >= this.maxConnections || !this._checkSendingRate()) {
            return;
        }

        if (!this.pending.length) {
            if (!this.idling) {
                this.idling = true;
                this.emit('idle');
            }
            return;
        }

        let next = this.pending.shift();
        this._send(next.mail, (...args) => {
            setImmediate(() => next.callback(...args));
            this._sent();
        });
    }

    _checkSendingRate() {
        clearTimeout(this.sendingRateTTL);

        let now = Date.now();
        let oldest = false;
        // delete older messages
        for (let i = this.rateMessages.length - 1; i >= 0; i--) {
            if (this.rateMessages[i].ts >= now - this.rateInterval && (!oldest || this.rateMessages[i].ts < oldest)) {
                oldest = this.rateMessages[i].ts;
            }

            if (this.rateMessages[i].ts < now - this.rateInterval && !this.rateMessages[i].pending) {
                this.rateMessages.splice(i, 1);
            }
        }

        if (this.rateMessages.length < this.sendingRate) {
            return true;
        }

        let delay = Math.max(oldest + 1001, now + 20);
        this.sendingRateTTL = setTimeout(() => this._checkRatedQueue(), now - delay);

        try {
            this.sendingRateTTL.unref();
        } catch (E) {
            // Ignore. Happens on envs with non-node timer implementation
        }

        return false;
    }

    _sent() {
        this.connections--;
        this._checkRatedQueue();
    }

    /**
     * Returns true if there are free slots in the queue
     */
    isIdle() {
        return this.idling;
    }

    /**
     * Compiles a mailcomposer message and forwards it to SES
     *
     * @param {Object} emailMessage MailComposer object
     * @param {Function} callback Callback function to run when the sending is completed
     */
    _send(mail, callback) {
        let statObject = {
            ts: Date.now(),
            pending: true
        };
        this.connections++;
        this.rateMessages.push(statObject);

/*
        const mail = {
            from: {
                name: getOverridable('from_name'),
                address: getOverridable('from_email')
            },
            replyTo: getOverridable('reply_to'),
            xMailer: sendConfiguration.x_mailer ? sendConfiguration.x_mailer : false,
            to,
            sender,
            envelope,
            headers,
            list: listHeader,
            subject,
            html: message.html,
            text: message.text,
            attachments: message.attachments,
            encryptionKeys
        };

 */
        console.log(mail);

/*
        let envelope = mail.data.envelope || mail.message.getEnvelope();
        let messageId = mail.message.messageId();

        let recipients = [].concat(envelope.to || []);
        if (recipients.length > 3) {
            recipients.push('...and ' + recipients.splice(2).length + ' more');
        }

        this.logger.info(
            {
                tnx: 'send',
                messageId
            },
            'Sending message %s to <%s>',
            messageId,
            recipients.join(', ')
        );

        let getRawMessage = next => {
            // do not use Message-ID and Date in DKIM signature
            if (!mail.data._dkim) {
                mail.data._dkim = {};
            }
            if (mail.data._dkim.skipFields && typeof mail.data._dkim.skipFields === 'string') {
                mail.data._dkim.skipFields += ':date:message-id';
            } else {
                mail.data._dkim.skipFields = 'date:message-id';
            }

            let sourceStream = mail.message.createReadStream();
            let stream = sourceStream.pipe(new LeWindows());
            let chunks = [];
            let chunklen = 0;

            stream.on('readable', () => {
                let chunk;
                while ((chunk = stream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            sourceStream.once('error', err => stream.emit('error', err));

            stream.once('error', err => {
                next(err);
            });

            stream.once('end', () => next(null, Buffer.concat(chunks, chunklen)));
        };

        setImmediate(() =>
            getRawMessage((err, raw) => {
                if (err) {
                    this.logger.error(
                        {
                            err,
                            tnx: 'send',
                            messageId
                        },
                        'Failed creating message for %s. %s',
                        messageId,
                        err.message
                    );
                    statObject.pending = false;
                    return callback(err);
                }

                let sesMessage = {
                    RawMessage: {
                        // required
                        Data: raw // required
                    },
                    Source: envelope.from,
                    Destinations: envelope.to
                };

                Object.keys(mail.data.ses || {}).forEach(key => {
                    sesMessage[key] = mail.data.ses[key];
                });

                let ses = (this.ses.aws ? this.ses.ses : this.ses) || {};
                let aws = this.ses.aws || {};

                let getRegion = cb => {
                    if (ses.config && typeof ses.config.region === 'function') {
                        // promise
                        return ses.config
                            .region()
                            .then(region => cb(null, region))
                            .catch(err => cb(err));
                    }
                    return cb(null, (ses.config && ses.config.region) || 'us-east-1');
                };

                getRegion((err, region) => {
                    if (err || !region) {
                        region = 'us-east-1';
                    }

                    let sendPromise;
                    if (typeof ses.send === 'function' && aws.SendRawEmailCommand) {
                        // v3 API
                        sendPromise = ses.send(new aws.SendRawEmailCommand(sesMessage));
                    } else {
                        // v2 API
                        sendPromise = ses.sendRawEmail(sesMessage).promise();
                    }

                    sendPromise
                        .then(data => {
                            if (region === 'us-east-1') {
                                region = 'email';
                            }

                            statObject.pending = false;
                            callback(null, {
                                envelope: {
                                    from: envelope.from,
                                    to: envelope.to
                                },
                                messageId: '<' + data.MessageId + (!/@/.test(data.MessageId) ? '@' + region + '.amazonses.com' : '') + '>',
                                response: data.MessageId,
                                raw
                            });
                        })
                        .catch(err => {
                            this.logger.error(
                                {
                                    err,
                                    tnx: 'send'
                                },
                                'Send error for %s: %s',
                                messageId,
                                err.message
                            );
                            statObject.pending = false;
                            callback(err);
                        });
                });
            })
        );
*/
    }

    _sendGraphEmail = async (fromAddress, recipients) => {
        const mail = {
            subject: "Microsoft Graph JavaScript Sample",
            toRecipients: [
                {
                    emailAddress: {
                        address: toAddress,
                    },
                },
            ],
            body: {
                content: "<h1>MicrosoftGraph JavaScript Sample</h1>Check out https://github.com/microsoftgraph/msgraph-sdk-javascript",
                contentType: "html",
            },
        };

        try {
            const endpoint = `/users/${fromAddress}/sendMail`;
            console.log(endpoint)
            const client = initClient();
            let response = await client
                .api(endpoint)
                .responseType(graph.ResponseType.RAW)
                .post({message: mail});

            //console.log(await readStream(response));

            console.log(response);
        }
        catch(err) {
            console.log(err);
        }
    }
    /**
     * Verifies SES configuration
     *
     * @param {Function} callback Callback function
     */
    verify(callback) {
        let promise;
        let ses = (this.ses.aws ? this.ses.ses : this.ses) || {};
        let aws = this.ses.aws || {};

        const sesMessage = {
            RawMessage: {
                // required
                Data: 'From: invalid@invalid\r\nTo: invalid@invalid\r\n Subject: Invalid\r\n\r\nInvalid'
            },
            Source: 'invalid@invalid',
            Destinations: ['invalid@invalid']
        };

        if (!callback) {
            promise = new Promise((resolve, reject) => {
                callback = shared.callbackPromise(resolve, reject);
            });
        }
        const cb = err => {
            if (err && (err.code || err.Code) !== 'InvalidParameterValue') {
                return callback(err);
            }
            return callback(null, true);
        };

        if (typeof ses.send === 'function' && aws.SendRawEmailCommand) {
            // v3 API
            sesMessage.RawMessage.Data = Buffer.from(sesMessage.RawMessage.Data);
            ses.send(new aws.SendRawEmailCommand(sesMessage), cb);
        } else {
            // v2 API
            ses.sendRawEmail(sesMessage, cb);
        }

        return promise;
    }
}

module.exports = GraphTransport;