const BtpPacket = require('btp-packet')
const crypto = require('crypto')
const debug = require('debug')('ilp-reverse-plugin')

class ReversePlugin {
  constructor (miniAccounts) {
    this._parent = miniAccounts
    this._requests = {}
  }

  async connect () {}
  async sendData (data) {
    const requestId = crypto.randomBytes(4).readUInt32BE()
    const promise = new Promise((resolve, reject) => {
      debug('setting request promise')
      this._requests[requestId] = { resolve, reject }
    })

    debug('injecting btp packet with ilp', data)
    await this._parent._handleIncomingBtpPacket(this._parent._prefix + 'spsp.x', {
      type: BtpPacket.TYPE_MESSAGE,
      requestId,
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data
        }]
      }
    })

    return promise
  }

  async _handleOutgoingBtpPacket (to, btpPacket) {
    debug('got', to, btpPacket)
    const { type, requestId, data } = btpPacket
    const { protocolData } = data
    const ilp = protocolData
      .filter(p => p.protocolName === 'ilp')[0]

    if (type === BtpPacket.TYPE_RESPONSE) {
      debug('resolving promise. ilp=', ilp)
      return this._requests[requestId].resolve(ilp.data)
    } else if (type === BtpPacket.TYPE_ERROR) {
      return this._requests[requestId].reject(new Error('Btp Error:' +
        JSON.stringify(data)))
    }

    try {
      if (!ilp) throw new Error('no ILP data in request')
      const response = await this._dataHandler(ilp.data)
      this._parent.emit('__callback_' + requestId,
        BtpPacket.TYPE_RESPONSE, {
          protocolData: [{
            protocolName: 'ilp',
            contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
            data: response
          }]
        })
    } catch (e) {
      this._parent.emit('__callback_' + requestId,
        BtpPacket.TYPE_ERROR, {
          code: 'F00',
          name: 'NotAcceptedError',
          data: e.message,
          triggeredAt: new Date().toISOString(),
          protocolData: []
        })
    }
  }

  registerDataHandler (handler) {
    this._dataHandler = handler
  }

  deregisterDataHandler () {
    this._dataHandler = null
  }
}

ReversePlugin.version = 2
module.exports = ReversePlugin
