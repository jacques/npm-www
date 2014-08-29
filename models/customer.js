module.exports = customer

var request = require('request')
var config = require('../config.js')

function customer(email, cb) {

  var customerEndpoint = config.license.api + '/customer'
  request.get({
    url: customerEndpoint + '/' + email,
    json: true
  },function(er,httpResponse,body) {
    if (httpResponse.statusCode == 404) {
      cb(null, null) // no error, but no customer either
    }
    else if (httpResponse.statusCode == 200) {
      console.warn("model found customer",body)
      cb(null, body)
    }
    else {
      cb(true)
    }
  })

}