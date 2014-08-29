var request = require('request')
var nodemailer = require('nodemailer')
var url = require('url')

var config = require('../config.js')
var transport = require(config.mailTransportModule)
var mailer = nodemailer.createTransport(
  transport(config.mailTransportSettings)
)

module.exports = {
  signUpStep1: signUpStep1,
  signUpStep2: signUpStep2,
  signUpStep3: signUpStep3,
  signUpStep4: signUpStep4
}

// when they submit the initial signup form
function signUpStep1(req, res) {
  console.warn("Step 1 started")
  if (req.method != "POST") {
    console.warn("NO POST")
    return res.error(405)
  }
  console.warn("here")
  req.maxLen = 1024 * 1024
  return req.on('form', function (data) {
    console.warn("form found")
    createHubspotLead(req.model,res,data)
  })
}

function createHubspotLead(model,res,data) {
  var hubspot = config.license.hubspot.forms
    .replace(":portal_id",config.license.hubspot.portal_id)
    .replace(":form_guid",config.license.hubspot.form_npme_signup)

  // we don't have a good way to check if they already have a hubspot lead
  // so just post every time.
  var req = request.post(hubspot,function(er,httpResponse,body) {
    console.warn("httpResponse",httpResponse.statusCode)
    // it shouldn't really be 302 but we can't seem to make it stop redirecting
    if (httpResponse.statusCode == 204 || httpResponse.statusCode == 302) {
      return getOrCreateCustomer(model,res,data)
    } else {
      var td = {
        title: "Problem with signup",
        errorMessage: "",
        errorCode: "1001"
      }
      return res.template('enterprise-error.ejs', td)
    }

  }).form({
    comments: data.comments,
    firstname: data.firstname,
    lastname: data.lastname,
    email: data.email,
    phone: data.phone,
    company: data.company,
    numemployees: data.numeployees,
    hs_context: {
      pageName: "enterprise-signup"
    }
  })


}

function getOrCreateCustomer(model,res,data) {

  model.load('customer',data.email)
  model.end(function(er,modelData) {
    if (er) {
      // customer API problem of some kind
      var td = {
        title: "Problem with signup",
        errorMessage: "There was an unknown problem with your customer record",
        errorCode: "1003"
      }
      return res.template('enterprise-error.ejs', td)
    }
    var customer = modelData.customer
    if (customer) {
      // they are already a customer
      return showClickThroughAgreement(res, customer)
    } else {
      // new customer, so create them
      var customerEndpoint = config.license.api + '/customer'
      request.put({
        url: customerEndpoint,
        json: {
          email: data.email,
          name: data.firstname + ' ' + data.lastname,
          phone: data.phone
        }
      },function(er,httpResponse,newCustomer) {
        // stop if we couldn't create the customer
        if(httpResponse.statusCode != 200) {
          console.warn("customer creation failed:",httpResponse.statusCode)
          console.warn(newCustomer)
          var td = {
            title: "Problem with signup",
            errorMessage: "There was a problem creating your customer record",
            errorCode: "1002"
          }
          return res.template('enterprise-error.ejs',td)
        }
        return showClickThroughAgreement(res,newCustomer)
      })
    }

  })
}

function showClickThroughAgreement(res,customer) {
  // we use both email and ID so people can't just guess an ID to get a license
  console.warn("clickthrough shown with:",customer)
  var td = {
    title: "Terms and Conditions",
    customer_id: customer.id,
    customer_email: customer.email
  }
  return res.template('enterprise-signup-2.ejs',td)
}

// when they agree to the ULA
function signUpStep2(req,res) {
  if (req.method != "POST") {
    return res.error(405)
  }
  return req.on('form', function(data) {
    checkCustomerExists(req.model,res,data)
  })
}

function checkCustomerExists(model,res,data) {
  console.warn("verifying customer with data",data)
  model.load('customer',data.customer_email)
  model.end(function(er,modelData) {
    if(er) {
      // customer API problem of some kind
      var td = {
        title: "Problem with signup",
        errorMessage: "There was an unknown problem with your customer record",
        errorCode: "2001"
      }
      return res.template('enterprise-error.ejs', td)
    }
    var customer = modelData.customer
    if(customer) {
      if (customer.id == data.customer_id) {
        // no spoof
        createTrial(res,customer)
      } else {
        // customer email but no ID? How did you get here?
        var td = {
          title: "Problem with signup",
          errorMessage: "Unable to verify your customer record",
          errorCode: "2002"
        }
        return res.template('enterprise-error.ejs', td)
      }

    } else {
      // no customer on page 2 is a problem
      var td = {
        title: "Problem with signup",
        errorMessage: "Unable to locate your customer record",
        errorCode: "2003"
      }
      return res.template('enterprise-error.ejs', td)
    }
  })
}

function createTrial(res,customer) {

  var trialEndpoint = config.license.api + '/trial'
  var productId = config.npme.product_id
  var trialLength = config.npme.trial_length
  var trialSeats = config.npme.trial_seats

  // check if they already have a trial; 1 per customer
  // no model call because the models are stupid and I hate them
  request.get({
    url: trialEndpoint + '/' + productId + '/' + customer.email,
    json: true
  },function(er,httpResponse,body) {
    if (httpResponse.statusCode == 404) {
      // do not already have a trial, so create one
      request.put({
        url: trialEndpoint,
        json: {
          customer_id: customer.id,
          product_id: productId,
          length: trialLength,
          seats: trialSeats
        }
      },function(er,httpResponse,trial) {
        console.warn("trial creation response:",httpResponse.statusCode)
        // stop if we couldn't create the trial
        if(httpResponse.statusCode != 200) {
          var td = {
            title: "Problem with signup",
            errorMessage: "There was a problem creating your trial",
            errorCode: "3001"
          }
          return res.template('enterprise-error.ejs',td)
        }
        return sendVerificationEmail(res,customer,trial)
      })
    }
    else if (httpResponse.statusCode == 200) {
      // they are already have a trial, re-send the verification email
      // body of the response is the trial object
      return sendVerificationEmail(res,customer,body)
    } else {
      // trial API problem of some kind
      var td = {
        title: "Problem with signup",
        errorMessage: "There was an unknown problem with your trial",
        errorCode: "3003"
      }
      return res.template('enterprise-error.ejs', td)
    }
  })

}

function sendVerificationEmail(res,customer,trial) {

  var from = config.emailFrom
  var mail = {
    to: '"' + customer.name + '" <' + customer.email + '>',
    from: '" npm Enterprise " <' + from + '>',
    subject: "npm Enterprise: please verify your email",
    text: "Hi " + customer.name + " -\r\n\r\n" +
      "Thanks for trying out npm Enterprise!\r\n\r\n" +
      "To get started, please click this link to verify your email address:\r\n\r\n" +
      "https://" + config.host + "/enterprise-verify?v=" + trial.verification_key + "\r\n\r\n" +
      "Thanks!\r\n\r\n" +
      "If you have questions or problems, you can reply to this message,\r\n" +
      "or email " + from + "\r\n" +
      "\r\n\r\nnpm loves you.\r\n"
  }
  console.warn("Sending email: ",mail)
  mailer.sendMail(mail, function() {
    // redirect here to prevent refreshing the page re-submitting and causing weirdness
    return res.redirect('/enterprise-signup-3')
  })

}

// when they submit the initial signup form
function signUpStep3(req, res) {
  var td = {
    title: "Thanks for signing up for npm Enterprise!"
  }
  return res.template('enterprise-signup-3.ejs',td)
}

// when the click the verification link in the email
function signUpStep4(req, res) {
  var qs = url.parse(req.url,true).query
  console.warn("step 4 query:",qs)
  if (!qs.v) {
    var td = {
      title: "Error verifying email",
      errorMessage: "We could not find your verification key. " +
        "Try cutting and pasting the URL from the email instead.",
      errorCode: "4001"
    }
    return res.template('enterprise-error.ejs',td)
  }
  verifyTrial(req.model,res,qs.v)
}

function verifyTrial(model,res,verificationKey) {

  var trialEndpoint = config.license.api + '/trial'
  console.warn("Looking for verification key",verificationKey)

  // first see if there's a trial with this verification key
  request.get({
    url: trialEndpoint + '/' + verificationKey,
    json: true
  },function(er,httpResponse,trial) {
    if (httpResponse.statusCode == 200) {
      // trial exists. is it already verified?
      if (trial.verified) {
        sendAndShowLicense(model,res,trial)
      } else {
        // need to verify the trial, which will also create the license
        request.put({
          url: trialEndpoint + '/' + trial.id + '/verification',
          json: true
        },function(er,httpResponse,verifiedTrial) {
          console.warn("trial verification response:",httpResponse.statusCode)
          // if verification failed, stop
          if(httpResponse.statusCode != 200) {
            var td = {
              title: "Problem with verification",
              errorMessage: "There was a problem starting your trial",
              errorCode: "5001"
            }
            return res.template('enterprise-error.ejs',td)
          }
          sendAndShowLicense(model,res,verifiedTrial)
        })
      }
    }
    else if (httpResponse.statusCode == 404) {
      // can't find a trial for that key
      var td = {
        title: "Problem verifying trial",
        errorMessage: "Your verification key was not found",
        errorCode: "5002"
      }
      return res.template('enterprise-error.ejs',td)
    } else {
      // trial API problem of some kind
      var td = {
        title: "Problem verifying trial",
        errorMessage: "There was an unknown problem with your trial",
        errorCode: "5003"
      }
      return res.template('enterprise-error.ejs', td)
    }
  })

}

function sendAndShowLicense(model, res, trial) {

  var requirementsUrl = "https://docs.npmjs.com/enterprise/installation#requirements"
  var instructionsUrl = "https://docs.npmjs.com/enterprise/installation"

  model.load('customer',trial.customer_id)
  model.load('licenses',config.npme.product_id,trial.customer_id)
  model.end(function(er,data) {
    var customer = data.customer
    var licenses = data.licenses
    // zero licenses bad, more than one license confusing
    if (licenses.length != 1) {
      var td = {
        title: "Problem displaying license",
        errorMessage: "There was an unknown problem with your trial license",
        errorCode: "6001"
      }
      return res.template('enterprise-error.ejs', td)
    }
    // all good. send the license via email
    var license = licenses[0]
    var from = config.emailFrom
    var mail = {
      to: '"' + customer.name + '" <' + customer.email + '>',
      from: '" npm Enterprise " <' + from + '>',
      subject : "npm Enterprise: trial license key and instructions",
      text: "Hi " + customer.name + " -\r\n\r\n" +
        "Thanks for trying out npm Enterprise!\r\n\r\n" +
        "To get started, make sure you have a machine that meets the installation requirements:\r\n\r\n" +
        requirementsUrl + "\r\n\r\n" +
        "Then simply run\r\n\r\n" +
        "npm install npme\r\n\r\n" +
        "That's it! When prompted, provide the following information:\r\n\r\n" +
        "billing email: " + customer.email + "\r\n" +
        "license key: " + license.license_key + "\r\n\r\n" +
        "For help with the other questions asked during the installation, read " +
        "the installation instructions and other documentation:\r\n\r\n" +
        instructionsUrl + "\r\n\r\n" +
        "If you have any problems, please email " + from + "\r\n" +
        "\r\n\r\nnpm loves you.\r\n"
    }
    mailer.sendMail(mail, function() {
      // show the success page
      var td = {
        title: "Signup complete!",
        requirementsUrl: requirementsUrl,
        instructionsUrl: instructionsUrl,
        email: customer.email,
        license_key: license.license_key,
        supportEmail: from
      }
      return res.template('enterprise-complete.ejs', td)
    })
  })

}