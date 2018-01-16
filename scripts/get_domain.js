const base32 = require('base32')
const addressCodec = require('ripple-address-codec')

const address = process.argv[2]
console.log('ripple-address:  ', address)
console.log('domain:          ',
  base32.encode(addressCodec.decode(address)) +
  '.spsp.siren.sh')
console.log('payment pointer: ',
  '$siren.sh/' + address)
