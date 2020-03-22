#!/usr/bin/env node

const fs = require('fs')
const https = require('https')
const mqtt = require('mqtt')
const Sentry = require('@sentry/node')

Sentry.init()

// persist IFTTT key and current state to disk so we can restore on restart
const DATA_PATH = '/data/ifttt/ifttt.json'

// protect data file from being written simultaneously
let isWriting = false
// data to be persisted
let data = {
  iftttKey: null,
  sensorVals: {}
}

// attempt to read previous data cache, if it exists
if (fs.existsSync(DATA_PATH)) {
  const dataFile = fs.readFileSync(DATA_PATH, {encoding: 'utf8'})
  try {
    data = {...data, ...JSON.parse(dataFile)}
  } catch(e) {
    Sentry.captureException(e)
    Sentry.captureMessage(dataFile)
  }
}

// cache data file to disk because we don't want lights to turn on if system reboots in middle of night
function persistDataFile() {
  if (!isWriting) {
    isWriting = true
    fs.writeFile(DATA_PATH, JSON.stringify(data), function(err) {
      if (err) Sentry.captureException(err)
      isWriting = false
    })
  }
}

function saveUsername(name) {
  data.iftttKey = name
  persistDataFile()
}

function publishOccupiedOrEmpty(sensorId, newCount) {
  const oldCount = data.sensorVals[sensorId]
  if (oldCount === 0 && newCount > 0) return 'occupied'
  if (oldCount > 0 && newCount === 0) return 'empty'
  return null
}

function sensorValChanged(sensorId, val) {
  if (data.sensorVals[sensorId] === val) return false

  data.sensorVals[sensorId] = val
  persistDataFile()

  return true
}

// clean out punctuation and spaces from room names
function sanitizeName(str) {
  return str.replace(/[^\w\s_\-]/g, "").trim().replace(/\s+/g, "_").toLowerCase()
}

function publishEvent(event) {
  if (!data.iftttKey) return
  // strip key out of url in case a full URL was provided
  const kArr = data.iftttKey.split('/')
  const key = kArr[kArr.length-1]
  https.get('https://maker.ifttt.com/trigger/' + event + '/with/key/' + key)
}

const hiome = mqtt.connect('mqtt://localhost:1883')

hiome.on('connect', function() {
  hiome.subscribe('_hiome/integrate/ifttt', {qos: 1})
  hiome.subscribe('hiome/1/sensor/#', {qos: 1})
})

hiome.on('message', function(topic, m, packet) {
  if (topic === '_hiome/integrate/ifttt') {
    saveUsername(m.toString())
    return
  }

  if (m.length === 0) return
  const message = JSON.parse(m.toString())

  if (message['meta'] && message['meta']['type'] === 'occupancy' && message['meta']['source'] === 'gateway') {
    const sensorId = message['meta']['room']
    // must fetch occupied or empty status before checking if sensorValChanged since that will overwrite old value
    const occupied = publishOccupiedOrEmpty(sensorId, message['val'])
    // only do something if the occupancy state of the room is changing
    if (!sensorValChanged(sensorId, message['val'])) return

    const sensorName = sanitizeName(message['meta']['name'].replace('Occupancy', ''))
    const event_base = 'hiome_' + sensorName + '_'
    if (occupied) publishEvent(event_base + occupied)
    publishEvent(event_base + 'count' + message['val'])
  } else if (message['meta'] && message['meta']['type'] === 'door' && message['meta']['source'] === 'gateway') {
    if (['closed', 'opened', 'ajar'].indexOf(message['val']) === -1) return
    const sensorId = topic.split('/').pop()
    // only do something if the door state is changing
    if (!sensorValChanged(sensorId, message['val'])) return

    const sensorNames = message['meta']['name'].split(' <-> ')
    const sn1 = sanitizeName(sensorNames[0])
    const sn2 = sanitizeName(sensorNames[1])
    publishEvent('hiome_' + sn1 + '_' + sn2 + '_door_' + message['val'])
  }
})
