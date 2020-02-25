#!/usr/bin/python

import os
import raven
import re
import paho.mqtt.client as mqtt

with open(os.getenv('UID_FILE', '/sys/class/net/eth0/address'), "r") as file:
  MACHINEID = file.read().strip()

raven.Client(
  release=raven.fetch_git_sha(os.path.dirname(__file__)),
  site=MACHINEID,
  name='hiome-ifttt'
).user_context({'id': MACHINEID})

MQTT_HOST = os.getenv('MQTT_HOST', 'localhost')
MQTT_PORT = os.getenv('MQTT_PORT', 1883)

ifttt_key = None

def publishEvent(event):
  urllib2.urlopen('https://maker.ifttt.com/trigger/' + event + '/with/key/' + ifttt_key)

def sanitizeName(name):
  name = re.sub('[^\w\s_]', '', name)
  name = name.strip()
  name = re.sub('\s+', '_', name)
  return name

def onMessage(client, userdata, msg):
  global ifttt_key
  if msg.topic == '_hiome/integrate/ifttt':
    ifttt_key = msg.payload or None
  elif ifttt_key is not None:
    message = msg.payload
    if message['meta'] and message['meta']['type'] == 'occupancy' and message['meta']['source'] == 'gateway':
      sensorId = message['meta']['room']
      sensorName = sanitizeName(message['meta']['name'])
      event_name_base = 'hiome_' + sensorName + '_'
      if message['val'] == 0:
        publishEvent(event_name_base + 'empty')
      else:
        publishEvent(event_name_base + 'occupied')
      publishEvent(event_name_base + 'count' + message['val'])
    elif message['meta'] and message['meta']['type'] == 'door' and message['meta']['source'] == 'gateway':
      sensorNames = message['meta']['name'].split(' <-> ')
      sn1 = sanitizeName(sensorNames[0])
      sn2 = sanitizeName(sensorNames[1])
      publishEvent('hiome_' + sn1 + '_' + sn2 + '_door_' + message['val'])

def onConnect(client, userdata, flags, rc):
  client.subscribe('_hiome/integrate/ifttt', qos=1)
  client.subscribe('hiome/1/sensor/#', qos=1)

client = mqtt.Client(client_id='hiome-ifttt', clean_session=False)
client.on_connect = onConnect
client.on_message = onMessage

while True:
  try:
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    break
  except:
    pass

client.loop_forever()
