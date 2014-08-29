var touch = require('touch')
var spawn = require('child_process').spawn
var once = require('once')

// flow control is fun!
function queue () {
  var args = [].slice.call(arguments)
  var cb = args.pop()
  go(args.shift())
  function go (fn) {
    if (!fn) return cb()
    fn(function (er) {
      if (er) return cb(er)
      go(args.shift())
    })
  }
}

var children = []
function exec (cmd, args, wait, cb) {
  console.log("Running %j %j",cmd,args)
  if (typeof wait === 'function') cb = wait, wait = 200
  cb = once(cb)

  var opts = {stdio:'inherit'}
  // windows is kind of a jerk sometimes.
  if (process.platform === 'win32') {
    args = ['/c', '"' + cmd + '"'].concat(args)
    cmd = 'cmd'
    opts.windowsVerbatimArguments = true
  }
  var child = spawn(cmd, args, opts)

  var timer = setTimeout(cb, wait)

  child.on('exit', function (code) {
    clearTimeout(timer)
    var er
    if (code) {
      msg = cmd + ' ' + args.join(' ') + ' fell over: '+code
      console.error(msg)
      er = new Error(msg)
    }
    cb(er)
  })
  children.push(child)
}

// best effort
process.on('exit', function() {
  children.forEach(function(child) {
    try {
      child.kill('SIGKILL')
    } catch (er) {}
  })
})

var mode = 'all'
var validModes = ['all','www-only','db-only']
if (process.argv[2]) {
  if (validModes.indexOf(process.argv[2]) > -1) mode = process.argv[2]
  else {
    console.log("Invalid run mode " + process.argv[2])
    exit(1)
  }
}

if (mode == 'all' || mode == 'db-only') {
  queue(function (cb) {
    // first, make sure that we have the databases, or replicate will fail
    touch('dev/couch/registry.couch', cb)

  }, function (cb) {
    touch('dev/couch/public_users.couch', cb)

  }, function (cb) {
    touch('dev/couch/downloads.couch', cb)

  }, function (cb) {
    // start elasticsearch
    exec('elasticsearch', [
      '-Des.config=dev/elasticsearch/elasticsearch.yml'
      , '-f'
    ], 5000, cb)

  }, function (cb) {
    // spawn couchdb, and make sure it stays up for a little bit
    exec('couchdb', ['-a', 'dev/couch/couch.ini'], cb)

  }, function (cb) {
    // do the same for redis.
    exec('redis-server', ['dev/redis/redis.conf'], cb)

  }, function (cb) {
    // wait 10 seconds for couch to start and download some data
    // otherwise the site is pretty empty.
    setTimeout(function() {
      exec(process.execPath, [require.resolve('./replicate.js')], 5000, cb)
    },10000)

  }, function (cb) {
    // by now, elastic search is probably up
    exec(process.execPath, [
      './node_modules/npm2es/bin/npm2es.js'
      , '--couch=http://localhost:15984/registry'
      , '--es=http://127.0.0.1:9200/npm'
    ], function (code) {
      console.error('did npm2es', code)
      cb(code)
    })

  }, function(er) {
    if(mode == 'all') {
      launchWww(er)
    }
  })
} else {
  launchWww()
}


function launchWww (er) {
  if (er) throw er

  console.error('\n\n\nSTARTING DEV SITE NOW\n\n\n')

  // force the configs to be pointed at our local redis and couchdb.
  var config = {}
  config.couchAuth = 'admin:admin'
  config.registryCouch = 'http://localhost:15984/'
  config.redis = { host: '127.0.0.1', port: 16379 }
  config.redisAuth = 'i-am-using-redis-in-development-mode-for-npm-www'
  config.keys = ['these keys are for dev mode only']
  config.stripe = {
    "secretkey": "sk_test_bxAixWI4b6LJJZlPSmX8z6hu",
    "publickey": "pk_test_dxl0gkFmBMdyGvhgt7Q86KwH"
  }

  // WARNING: production email account
  config.emailFrom = "support@npmjs.com"


  config.mailTransportModule = "nodemailer-ses-transport"
  config.mailTransportSettings = {
    accessKeyId: "xxx",
    secretAccessKey: "yyy",
    region: "us-west-2"
  }

  // fakey fake SSL certs for convenience.
  var fs = require('fs')
  config.https = {
    ca: [],
    key: fs.readFileSync(require.resolve('./ssl/server.key'), 'utf8'),
    cert: fs.readFileSync(require.resolve('./ssl/server.crt'), 'utf8')
  }

  config.port = 15443
  config.host = 'localhost'
  config.httpPort = 15080

  config.npm = config.npm || {
    registry: 'http://127.0.0.1:15984/',
    'strict-ssl': false,
    loglevel: 'info',
    username: '',
    _password: '',
    _auth: '',
    _token: ''
  }

  config.elasticsearch = config.elasticsearch || {
    url: 'http://127.0.0.1:9200/npm',
    pageSize: 20
  }

  config.downloads = {
    url: "https://api.npmjs.org/downloads/"
  }

  config.metrics = {
      collector: { host: 'dashboard-1-west.internal.npmjs.com', port: 3333 },
      prefix:     'www-dev'
  }

  config.license = {
    "hubspot": {
      "forms": "https://forms.hubspot.com/uploads/form/v2/:portal_id/:form_guid",
      "portal_id": "419727",
      "form_npme_signup": "56c0da62-e191-46b8-973d-9d57fa5b02f6",
      "form_npme_call_me": "xxx",
      "form_private_npm": "yyy"
    },
    "api": "http://10.0.2.2:5001",
  }

  config.npme = {
    "product_id": 2,
    "trial_length": 30,
    "trial_seats": 50
  }

  config.debug = true

  // write to the dev admin config.
  fs.writeFileSync('config.dev.js',
    'module.exports = ' + JSON.stringify(config, null, 2),
    'utf8')

  process.env.NODE_ENV = 'dev'
  process.env.CLUSTER_MASTER_REPL = 15337

  // now we've replicated everything, and set up the configs,
  // and it worked, so start up the master http server.
  require('../server.js')
}
