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

Clients connecting to this plugin should connect with a server url of:

```
"btp+ws://:<token>@localhost:8080/<ripple_address>"
```

The `<ripple_address>` in the URL determines where settlements are sent.  Once
you have authenticated with a `<token>` and a `<ripple_address>`, you cannot
supply any other `<ripple_address>` when connecting to that account. This is to
prevent funds from being diverted if anyone should find out your `<token>`.
