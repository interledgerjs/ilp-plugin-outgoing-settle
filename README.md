# ILP Plugin Outgoing Settle
> Outgoing-only plugin that sends XRP settlements. Edit

- [Description](#description)
- [Example](#example)

## Description

This plugin allows users to connect dynamically (similar to mini-accounts), and
then fulfill incoming payments. They cannot send outgoing payments from this
plugin, so all balance logic is one-way. The plugin buffers their incoming ILP
payments and periodically settles them on-chain via XRP.

Although it is not included in this plugin, this 'accumulate and settle' model
can be written for other systems. For systems more expensive than XRP, the fee
should be taken into account when sending settlements.

Once the receiver has accumulated `settleThreshold` drops, (by default
25,000,000 = 25 XRP), this plugin will trigger an XRP payment to that address.

## Example

```js
const plugin = new IlpPluginOutgoingSettle({
  port: 8080,
  secret: 's...',
  address: 'r...',
  xrpServer: 'wss://s1.ripple.com',
  settleThreshold: 25 * Math.pow(10, 6), // default 25 XRP (25,000,000 drops)
  _store: new Store() // passed in by connector automatically
})
```

The `_store` in this case needs to have been modified from outside for this
plugin to work. For any `<account>` that connects, there must be a store entry
at `<account>:xrp_address` containing its XRP address.

_TODO: Should the client put the XRP address into the path they're connecting
to instead? It would cause strange behavior when the user has several
connections, but that functionality is going to be removed anyways._
