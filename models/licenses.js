module.exports = licenses

var request = require('request')
var config = require('../config.js')

function licenses(productId, customerId, cb) {

  var licenseEndpoint = config.license.api + '/license'
  request.get({
    url: licenseEndpoint + '/' + productId + '/' + customerId,
    json: true
  },function(er,httpResponse,body) {
    if (httpResponse.statusCode == 404) {
      cb(null, null) // no error, but no customer either
    }
    else if (httpResponse.statusCode == 200) {
      console.warn("model found licenses",body)
      cb(null, body.licenses)
    }
    else {
      cb(true)
    }
  })

}