// In-process events between the order flow (api-orders.js) and notifications/listings
// (listings.js), so the order code doesn't depend on e-mail:
//   'order.created'      { order }  paid order waiting for payment
//   'order.paid'         { order }  payment confirmed, ticket issued
//   'listing.registered' { order }  free standard listing request (ticket issued at once)
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
