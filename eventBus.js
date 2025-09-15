const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {}

module.exports = new Bus();