const express = require('express')
const reqlib = require('app-root-path').require
const morgan = require('morgan')
const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
const app = express()
const SerialPort = require('serialport')
const jsonStore = reqlib('/lib/jsonStore.js')
const cors = require('cors')
const ZWaveClient = reqlib('/lib/ZwaveClient')
const MqttClient = reqlib('/lib/MqttClient')
const Gateway = reqlib('/lib/Gateway')
const store = reqlib('config/store.js')
const loggers = reqlib('/lib/logger.js')
const logger = loggers.module('App')
const history = require('connect-history-api-fallback')
const SocketManager = reqlib('/lib/SocketManager')
const { inboundEvents, socketEvents } = reqlib('/lib/SocketManager.js')
const utils = reqlib('/lib/utils.js')
const fs = require('fs-extra')
const path = require('path')
const { storeDir } = reqlib('config/app.js')
const renderIndex = reqlib('/lib/renderIndex')
const archiver = require('archiver')
const { createCertificate } = require('pem').promisified
const rateLimit = require('express-rate-limit')

const storeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  handler: function (req, res) {
    res.json({
      success: false,
      message:
        'Request limit reached. You can make only 100 reqests every 15 minutes'
    })
  }
})

const socketManager = new SocketManager()

let gw // the gateway instance

// flag used to prevent multiple restarts while one is already in progress
let restarting = false

// ### UTILS

/**
 * Start http/https server and all the manager
 *
 * @param {string} host
 * @param {number} port
 */
async function startServer (host, port) {
  let server

  if (process.env.HTTPS) {
    logger.info('HTTPS is enabled. Loading cert and keys from store...')
    const { cert, key } = await loadCertKey()
    server = require('https').createServer(
      {
        key,
        cert,
        rejectUnauthorized: false
      },
      app
    )
  } else {
    server = require('http').createServer(app)
  }

  server.listen(port, host, function () {
    const addr = server.address()
    const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port
    logger.info(
      `Listening on ${bind} host ${host} protocol ${
        process.env.HTTPS ? 'HTTPS' : 'HTTP'
      }`
    )
  })

  server.on('error', function (error) {
    if (error.syscall !== 'listen') {
      throw error
    }

    const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port

    // handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        logger.error(bind + ' requires elevated privileges')
        process.exit(1)
      case 'EADDRINUSE':
        logger.error(bind + ' is already in use')
        process.exit(1)
      default:
        throw error
    }
  })

  setupSocket(server)
  setupInterceptor()
  startGateway()
}

/**
 * Get the `path` param from a request. Throws if the path is not safe
 *
 * @param {Express.Request} req
 * @returns {string} The path is it's safe, thorws otherwise
 */
function getSafePath (req) {
  const reqPath = req.params.path

  if (/[.]+\//g.test(reqPath)) {
    throw Error('Path contains invalid chars')
  }

  if (!reqPath.startsWith(storeDir)) {
    throw Error('Path not allowed')
  }

  return reqPath
}

async function loadCertKey () {
  const certFile = utils.joinPath(storeDir, 'cert.pem')
  const keyFile = utils.joinPath(storeDir, 'key.pem')

  let key
  let cert

  try {
    cert = await fs.readFile(certFile)
    key = await fs.readFile(keyFile)
  } catch (error) {}

  if (!cert || !key) {
    logger.info('Cert and key not found in store, generating fresh new ones...')

    const result = await createCertificate({
      days: 99999,
      selfSigned: true
    })

    key = result.serviceKey
    cert = result.certificate

    await fs.writeFile(keyFile, result.serviceKey)
    await fs.writeFile(certFile, result.certificate)
    logger.info('New cert and key created')
  }

  return { cert, key }
}

function setupLogging (settings) {
  loggers.setupAll(settings ? settings.gateway : null)
}

function startGateway () {
  const settings = jsonStore.get(store.settings)

  let mqtt
  let zwave

  setupLogging(settings)

  if (settings.mqtt) {
    mqtt = new MqttClient(settings.mqtt)
  }

  if (settings.zwave) {
    zwave = new ZWaveClient(settings.zwave, socketManager.io)
  }

  gw = new Gateway(settings.gateway, zwave, mqtt)

  gw.start()

  restarting = false
}

function setupInterceptor () {
  // intercept logs and redirect them to socket
  const interceptor = function (write) {
    return function (...args) {
      socketManager.io.emit('DEBUG', args[0].toString())
      write.apply(process.stdout, args)
    }
  }

  process.stdout.write = interceptor(process.stdout.write)
  process.stderr.write = interceptor(process.stderr.write)
}

// ### EXPRESS SETUP

logger.info(`Version: ${utils.getVersion()}`)
logger.info('Application path:' + utils.getPath(true))

// view engine setup
app.set('views', utils.joinPath(false, 'views'))
app.set('view engine', 'ejs')

app.use(morgan('dev', { stream: { write: msg => logger.info(msg.trimEnd()) } }))
app.use(bodyParser.json({ limit: '50mb' }))
app.use(
  bodyParser.urlencoded({
    limit: '50mb',
    extended: true,
    parameterLimit: 50000
  })
)
app.use(cookieParser())

app.use(
  history({
    index: '/'
  })
)

app.get('/', renderIndex)

app.use('/', express.static(utils.joinPath(false, 'dist')))

app.use(cors())

// ### SOCKET SETUP

/**
 * Binds socketManager to `server`
 *
 * @param {HttpServer} server
 */
function setupSocket (server) {
  socketManager.bindServer(server)

  socketManager.on(inboundEvents.init, function (socket) {
    if (gw.zwave) {
      socket.emit(socketEvents.init, {
        nodes: gw.zwave.nodes,
        info: gw.zwave.getInfo(),
        error: gw.zwave.error,
        cntStatus: gw.zwave.cntStatus
      })
    }
  })

  socketManager.on(inboundEvents.zwave, async function (socket, data) {
    if (gw.zwave) {
      const result = await gw.zwave.callApi(data.api, ...data.args)
      result.api = data.api
      socket.emit(socketEvents.api, result)
    }
  })

  socketManager.on(inboundEvents.hass, async function (socket, data) {
    logger.info(`Hass api call: ${data.apiName}`)
    switch (data.apiName) {
      case 'delete':
        gw.publishDiscovery(data.device, data.nodeId, true, true)
        break
      case 'discover':
        gw.publishDiscovery(data.device, data.nodeId, false, true)
        break
      case 'rediscoverNode':
        gw.rediscoverNode(data.nodeId)
        break
      case 'disableDiscovery':
        gw.disableDiscovery(data.nodeId)
        break
      case 'update':
        gw.zwave.updateDevice(data.device, data.nodeId)
        break
      case 'add':
        gw.zwave.addDevice(data.device, data.nodeId)
        break
      case 'store':
        await gw.zwave.storeDevices(data.devices, data.nodeId, data.remove)
        break
    }
  })
}

// ### APIs

app.get('/health', async function (req, res) {
  let mqtt = false
  let zwave = false

  if (gw) {
    mqtt = gw.mqtt ? gw.mqtt.getStatus() : false
    zwave = gw.zwave ? gw.zwave.getStatus().status : false
  }

  // if mqtt is disabled, return true. Fixes #469
  if (mqtt) {
    mqtt = mqtt.status || mqtt.config.disabled
  }

  const status = mqtt && zwave

  res.status(status ? 200 : 500).send(status ? 'Ok' : 'Error')
})

app.get('/health/:client', async function (req, res) {
  const client = req.params.client
  let status

  if (client !== 'zwave' && client !== 'mqtt') {
    res.status(500).send("Requested client doesn 't exist")
  } else {
    status = gw && gw[client] ? gw[client].getStatus().status : false
  }

  res.status(status ? 200 : 500).send(status ? 'Ok' : 'Error')
})

// get settings
app.get('/api/settings', async function (req, res) {
  const data = {
    success: true,
    settings: jsonStore.get(store.settings),
    devices: gw.zwave ? gw.zwave.devices : {},
    serial_ports: []
  }

  let ports
  if (process.platform !== 'sunos') {
    try {
      ports = await SerialPort.list()
    } catch (error) {
      logger.error(error)
    }

    data.serial_ports = ports ? ports.map(p => p.path) : []
    res.json(data)
  } else res.json(data)
})

// get config
app.get('/api/exportConfig', function (req, res) {
  return res.json({
    success: true,
    data: jsonStore.get(store.nodes),
    message: 'Successfully exported nodes JSON configuration'
  })
})

// import config
app.post('/api/importConfig', async function (req, res) {
  const config = req.body.data
  try {
    if (!gw.zwave) throw Error('Zwave client not inited')

    if (!Array.isArray(config)) throw Error('Configuration not valid')
    else {
      for (let i = 0; i < config.length; i++) {
        const e = config[i]
        if (
          e &&
          (!utils.hasProperty(e, 'name') || !utils.hasProperty(e, 'loc'))
        ) {
          continue
        } else if (e) {
          await gw.zwave.callApi('_setNodeName', i, e.name || '')
          await gw.zwave.callApi('_setNodeLocation', i, e.loc || '')
          if (e.hassDevices) {
            await gw.zwave.storeDevices(e.hassDevices, i, false)
          }
        }
      }
    }

    res.json({ success: true, message: 'Configuration imported successfully' })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

// get config
app.get('/api/store', storeLimiter, async function (req, res) {
  try {
    async function parseDir (dir) {
      const toReturn = []
      const files = await fs.readdir(dir)
      for (const file of files) {
        const entry = {
          name: path.basename(file),
          path: utils.joinPath(dir, file)
        }
        const stats = await fs.lstat(entry.path)
        if (stats.isDirectory()) {
          entry.children = await parseDir(entry.path)
        } else {
          entry.ext = file.split('.').pop()
        }

        entry.size = utils.humanSize(stats.size)
        toReturn.push(entry)
      }
      return toReturn
    }

    const data = await parseDir(storeDir)

    res.json({ success: true, data: data })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

app.get('/api/store/:path', storeLimiter, async function (req, res) {
  try {
    const reqPath = getSafePath(req)

    const stat = await fs.lstat(reqPath)

    if (!stat.isFile()) {
      throw Error('Path is not a file')
    }

    const data = await fs.readFile(reqPath, 'utf8')

    res.json({ success: true, data: data })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

app.put('/api/store/:path', storeLimiter, async function (req, res) {
  try {
    const reqPath = getSafePath(req)

    const stat = await fs.lstat(reqPath)

    if (!stat.isFile()) {
      throw Error('Path is not a file')
    }

    await fs.writeFile(reqPath, req.body.content, 'utf8')

    res.json({ success: true })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

app.delete('/api/store/:path', storeLimiter, async function (req, res) {
  try {
    const reqPath = getSafePath(req)

    await fs.remove(reqPath)

    res.json({ success: true })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

app.put('/api/store-multi', storeLimiter, async function (req, res) {
  try {
    const files = req.body.files || []
    for (const f of files) {
      await fs.remove(f)
    }
    res.json({ success: true })
  } catch (error) {
    logger.error(error.message)
    return res.json({ success: false, message: error.message })
  }
})

app.post('/api/store-multi', storeLimiter, function (req, res) {
  const files = req.body.files || []

  const archive = archiver('zip')

  archive.on('error', function (err) {
    res.status(500).send({
      error: err.message
    })
  })

  // on stream closed we can end the request
  archive.on('end', function () {
    logger.debug('zip archive ready')
  })

  // set the archive name
  res.attachment('zwavejs2mqtt-store.zip')
  res.setHeader('Content-Type', 'application/zip')

  // use res as stream so I don't need to create a temp file
  archive.pipe(res)

  for (const f of files) {
    archive.file(f, { name: f.replace(storeDir, '') })
  }

  archive.finalize()
})

// update settings
app.post('/api/settings', async function (req, res) {
  try {
    if (restarting) {
      throw Error(
        'Gateway is restarting, wait a moment before doing another request'
      )
    }
    restarting = true
    await jsonStore.put(store.settings, req.body)
    setupLogging(req.body)
    await gw.close()
    startGateway()
    res.json({ success: true, message: 'Configuration updated successfully' })
  } catch (error) {
    logger.error(error)
    res.json({ success: false, message: error.message })
  }
})

// ### ERROR HANDLERS

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  const err = new Error('Not Found')
  err.status = 404
  next(err)
})

// error handler
app.use(function (err, req, res) {
  // set locals, only providing error in development
  res.locals.message = err.message
  res.locals.error = req.app.get('env') === 'development' ? err : {}

  logger.error(`${req.method} ${req.url} ${err.status} - Error: ${err.message}`)

  // render the error page
  res.status(err.status || 500)
  res.redirect('/')
})

process.removeAllListeners('SIGINT')

process.on('SIGINT', function () {
  logger.info('Closing clients...')
  gw.close()
    .catch(err => {
      logger.error('Error while closing clients', err)
    })
    .finally(() => {
      process.exit()
    })
})

module.exports = { app, startServer }
