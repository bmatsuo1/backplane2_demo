/*
 * Copyright (c) 2006-2011 Echo <solutions@aboutecho.com>. All rights reserved.
 * You may copy and modify this script as long as the above copyright notice,
 * this condition and the following disclaimer is left intact.
 * This software is provided by the author "AS IS" and no warranties are
 * implied, including fitness for a particular purpose. In no event shall
 * the author be liable for any damages arising in any way out of the use
 * of this software, even if advised of the possibility of such damage.
 * $Id: backplane.js 32046 2011-03-31 08:53:15Z jskit $
 */

window.Backplane = window.Backplane || (function() {
    // Backplane is a function that accepts a function to be run onInit
    var BP = function(fn) {
        if (Backplane.getChannelID()) fn();
        else {
            Backplane.onInit = (function() {
                var original_onInit = Backplane.onInit;
                return function() {
                    original_onInit();
                    fn();
                };
            })();
        }
    };
    BP.log = function(msg) {
        if (window.console && window.console.log) {
            console.log("Backplane: " + msg);
        }
    }
    BP.warn = function(msg) {
        if (window.console && window.console.warn) {
            console.warn("Backplane WARNING: " + msg)
        }
    }
    BP.error = function(msg) {
        if (window.console && window.console.error) {
            console.error("Backplane ERROR: " + msg);
        }
    }
    BP.version = "2.0.0";
    BP.token = null;
    BP.channelName = null;
    BP.config = {};
    BP.initialized = false;
    BP.firstFrameReceived = false;
    BP.cachedMessages = {};
    BP.cachedMessagesIndex = [];
    BP.cacheMax = 0;
    BP.subscribers = {};
    BP.awaiting = {
        "since": 0,
        "until": 0,
        "queue": []
    };
    BP.intervals = {
        "min": 1,
        "frequent": 5,
        "regular": 60,
        "slowdown": 120
    };
    BP.onInit = function() {};
    BP.log("backplane2.js loaded");
    return BP;
})();

/**
 * Initializes the Backplane 2 library
 *
 * @param {Object} config - Hash with configuration parameters.
 *   Possible hash keys:
 *     serverBaseURL (required) - Base URL of Backplane Server
 *     busName (required) - Customer's backplane bus name
 *     channelExpires (optional) - set backplane2-channel cookie life span
 *     initFrameFilter (optional) - function to filter the first message frame
 *     cacheMax (optional) - how many messages to cache for late arriving widgets
 */
Backplane.init = function(config) {
    this.log("initializing");
    config = config || {};
    if (this.initialized) {
        this.log("library already initialized");
        return false;
    }
    if (!config.serverBaseURL) {
        this.error("must supply serverBaseURL");
        return false;
    }
    if (!config.busName) {
        this.error("must supply busName");
        return false;
    }

    this.initialized = true;
    this.timers = {};
    this.config = config;
    this.config.serverBaseURL = this.normalizeURL(config.serverBaseURL);

    if (this.config.serverBaseURL.indexOf("/v2") < 0) {
        this.error("serverBaseURL must include '/v2'");
        return false;
    }

    this.loadChannelFromCookie();

    this.cacheMax = config.cacheMax || this.cacheMax;

    if (typeof this.config.channelExpires == "undefined") {
        var d = new Date();
        d.setFullYear(d.getFullYear() + 5);
        this.config.channelExpires = d.toGMTString();
    }

    if (this.getChannelName()) {
        this.onInit();
        this.request();
    } else {
        this.fetchNewChannel();
    }
    return true;
};


/**
 * Subscribes to messages from Backplane server
 *
 * @param {Function} Callback - Callback function which accepts backplane messages
 * @returns Subscription ID which can be used later for unsubscribing
 */
Backplane.subscribe = function(callback) {
    if (!this.initialized) return false;
    var id = (new Date()).valueOf() + Math.random();
    this.subscribers[id] = callback;
    //if the first frame has already been processed, catch this widget up
    if (this.firstFrameReceived) {
        for (var i=0; i<this.cachedMessagesIndex.length; i++) {
            callback(this.cachedMessages[this.cachedMessagesIndex[i]]);
        }
    }
    return id;
};

/**
 * Removes specified subscription
 *
 * @param {Integer} Subscription ID
 */
Backplane.unsubscribe = function(subscriptionID) {
    if (!this.initialized || !subscriptionID) return false;
    delete this.subscribers[subscriptionID];
};

/**
 * Returns channel ID (like http://backplane.customer.com/v2/bus/customer.com/channel/8ec92f459fa70b0da1a40e8fe70a0bc8)
 *
 * @returns Backplane channel ID
 */
Backplane.getChannelID = function() {
    if (!this.initialized) return false;
    return this.channelID;
};

/**
 * Notifies Backplane library about the fact that subscribers are going
 * to receive backplane messages of any of the specified types
 *
 * @param {Array} List of expected Backplane message types
 */
Backplane.expectMessages = function(types) {
    this.expectMessagesWithin(60, types);
};

/**
 * Notifies backplane library about the fact that subscribers are going
 * to receive backplane messages within specified time interval.
 *
 * @param {Integer} TimeInterval Time interval in seconds
 */
Backplane.expectMessagesWithin = function(interval, types) {
    if (!this.initialized || !interval) return false;
    this.awaiting.since = this.getTS();
    this.awaiting.interval = interval;
    // we should wait entire interval if no types were specified
    this.awaiting.nonstop = !types;
    if (types) {
        types = typeof types == "string" ? [types] : types;
        this.awaiting.queue.push(types);
    }
    var until = this.awaiting.since + interval;
    if (until > this.awaiting.until) {
        this.awaiting.until = until;
    }
    this.request();
};

/**
 * Internal functions
 *
 */

/**
 * Init callback function
 * @param initPayload in the form {"access_token":"anJeTstYkz64Xf3XGaANFE","expires_in":3600,
 *              "token_type":"Bearer","scope":"channel:iEuR8VE9MDfmD3dBxbCtdqgYRtDsDnrh"}
 */
Backplane.finishInit = function (initPayload) {

    this.log("received access token and channel from server");
    this.token = initPayload.access_token;
    var scopes = initPayload.scope.split(" ");
    for (var k = 0; k < scopes.length; k++) {
        if (scopes[k].indexOf("channel:") > -1) {
            var channel = scopes[k].split(":");
            this.channelName = channel[1];
            this.log("channel set to: " + this.channelName);
        }
    }

    if (this.channelName == null) {
        this.error("No channel found in the returned scope");
    }

    this.setCookieChannel();
    this.channelID = this.generateChannelID();
    this.log("channelID = " + this.channelID);
    this.onInit();
    this.request();
};

Backplane.generateNextFrameURL = function() {
    if (typeof this.since == "undefined") {
        this.since = this.config.serverBaseURL + "/messages";
    }
    var localSince = this.since;
    if (localSince.indexOf('?') > -1 )  {
        localSince += "&";
    } else {
        localSince += "?";
    }

    return localSince + "callback=Backplane.response&access_token=" + this.token + "&rnd=" + Math.random();
};

Backplane.generateChannelID = function() {
    return this.config.serverBaseURL + "/bus/" + this.config.busName + "/channel/" + this.channelName;
};

Backplane.getChannelName = function() {
    if (!this.initialized) return false;
    if (this.channelName == null) return false;
    return this.channelName;
};

Backplane.getTS = function() {
    return Math.round((new Date()).valueOf() / 1000);
};

Backplane.loadChannelFromCookie = function() {
    var match = (document.cookie || "").match(/backplane2-channel=(.*?)(?:$|;)/);
    if (!match || !match[1]) return {};
    var parts = match[1].split(":");
    this.token = decodeURIComponent(parts[0]);
    this.channelName = decodeURIComponent(parts[1]);
    if (this.token.length < 20 || this.channelName.length < 30) {
        this.error("backplane2-channel value: '" + match[1] + "' is corrupt");
    } else {
        this.log("retrieved token and channel from cookie");
        this.channelID = this.generateChannelID();
        this.log("channelID = " + this.channelID);
    }
};

Backplane.setCookieChannel = function() {
    document.cookie = "backplane2-channel=" + encodeURIComponent(this.token) + ":" +
        encodeURIComponent(this.channelName) + ";expires=" + this.config.channelExpires + ";path=/";
};

Backplane.resetCookieChannel = function() {
    this.channelName = null;
    this.token = null;
    this.setCookieChannel();
    // make the async call to retrieve a server generated channel
    this.fetchNewChannel();
};

Backplane.fetchNewChannel = function() {
    var oldScript;
    // cleanup old script if it exists to prevent memory leak
    while (oldScript = document.getElementById('fetchChannelId')) {
        oldScript.parentNode.removeChild(oldScript);
        for (var prop in oldScript) {
            delete oldScript[prop];
        }
    }

    var script = document.createElement("script");
    script.src =  this.config.serverBaseURL + "/token?callback=Backplane.finishInit";
    script.type = "text/javascript";
    script.id = 'fetchChannelId';
    var firstScript = document.getElementsByTagName("script")[0];
    firstScript.parentNode.insertBefore(script, firstScript);

};


Backplane.normalizeURL = function(rawURL) {
    return rawURL.replace(/^\s*(https?:\/\/)?(.*?)[\s\/]*$/, function(match, proto, uri){
        return (proto || window.location.protocol + "//") + uri;
    });
};

Backplane.calcTimeout = function() {
    var timeout, ts = this.getTS();
    if (ts < this.awaiting.until) {
        // stop frequent polling as soon as all the necessary messages received
        if (!this.awaiting.nonstop && !this.awaiting.queue.length) {
            this.awaiting.until = ts;
            return this.calcTimeout();
        }
        var relative = ts - this.awaiting.since;
        var limit = this.intervals.frequent - this.intervals.min;
        // we should reach this.intervals.frequent at the end
        timeout = this.intervals.min +
            Math.round(limit * relative / this.awaiting.interval);
    } else if (ts < this.awaiting.until + this.intervals.slowdown) {
        var relative = ts - this.awaiting.until;
        var limit = this.intervals.regular - this.intervals.frequent;
        // we should reach this.intervals.regular at the end
        timeout = this.intervals.frequent +
            Math.round(limit * relative / this.intervals.slowdown);
    } else {
        timeout = typeof this.since == "undefined" ? 0 : this.intervals.regular;
        this.awaiting.nonstop = false;
    }
    return timeout * 1000;
};

Backplane.request = function() {
    var self = this;
    if (!this.initialized) return false;
    this.stopTimer("regular");
    this.stopTimer("watchdog");
    this.timers.regular = setTimeout(function() {
        // if no response in the reasonable time just restart request
        self.timers.watchdog = setTimeout(function() {
            self.request();
        }, 5000);
        var script = document.createElement("script");
        script.type = "text/javascript";
        script.charset = "utf-8";
        script.src = Backplane.generateNextFrameURL();

        var container = document.getElementsByTagName("head")[0] || document.documentElement;
        container.insertBefore(script, container.firstChild);
        script.onload = script.onreadystatechange = function() {
            var state = script.readyState;
            if (!state || state === "loaded" || state === "complete") {
                script.onload = script.onreadystatechange = null;
                if (script.parentNode) {
                    script.parentNode.removeChild(script);
                }
            }
        };
    }, this.calcTimeout());
};

/**
 * Callback function for message frame request
 * @param messages
 */

Backplane.response = function(messageFrame) {
    var self = this;
    this.stopTimer("watchdog");

    if (typeof this.since == "undefined") {
        if (typeof this.config.initFrameFilter != "undefined") {
            messageFrame.messages = this.config.initFrameFilter(messageFrame.messages);
        } else {
            messageFrame.messages = [];
        }
    }

    this.since = messageFrame.nextURL;

    for (var i = 0; i < messageFrame.messages.length; i++) {
        // notify subscribers
        for (var j in this.subscribers) {
            if (this.subscribers.hasOwnProperty(j)) {
                this.subscribers[j](messageFrame.messages[i]);
            }
        }
        // stash message in cache
        if (this.cacheMax > 0) {
            if (!this.cachedMessages.hasOwnProperty(messageFrame.messages[messages[i].messageURL])) {
                this.cachedMessages[messageFrame.messages[i].messageURL] = messageFrame.messages[i];
                this.cachedMessagesIndex.push(messageFrame.messages[i].messageURL);
            }
            if (this.cachedMessagesIndex.length > this.cacheMax) {
                delete this.cachedMessages[this.cachedMessagesIndex[0]];
                this.cachedMessagesIndex.splice(0,1);
            }
        }

        // clean up awaiting specific events queue
        var queue = [];
        for (var k = 0; k < this.awaiting.queue.length; k++) {
            var satisfied = false;
            for (var l = 0; l < this.awaiting.queue[k].length; l++) {
                if (this.awaiting.queue[k][l] == messageFrame.messages[i].type) {
                    satisfied = true;
                }
            }
            if (!satisfied) queue.push(this.awaiting.queue[k]);
        }
        this.awaiting.queue = queue;
    }
    this.firstFrameReceived = true;
    this.request();
};

Backplane.stopTimer = function(name) {
    var timer = this.timers[name];
    if (timer) clearTimeout(timer);
};