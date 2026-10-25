import assert from 'node:assert/strict'
import test from 'node:test'
import { OverwriteType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js'
import { lockedOverwrites, renameDue } from './squadron-stats.js'

test('a stats channel at the top of the list is viewed by everyone and closed for everything else the bot can deny', () => {
  // Test pechenka's bot: @everyone's server permissions plus View Channel and Manage Channels on its role.
  const everyone = P.SendMessages | P.ReadMessageHistory | P.AddReactions | P.Connect | P.Speak | P.Stream
    | P.UseVAD | P.UseSoundboard | P.UseEmbeddedActivities | P.SendVoiceMessages | P.ChangeNickname
  const [overwrite, own] = lockedOverwrites('guild', 'bot', everyone | P.ViewChannel | P.ManageChannels)
  assert.equal(overwrite?.id, 'guild', 'the @everyone overwrite')
  assert.equal(overwrite.type, OverwriteType.Role)
  assert.equal(overwrite.allow, P.ViewChannel)
  const denied = new PermissionsBitField(overwrite.deny)
  for (const bit of [P.Connect, P.Speak, P.Stream, P.SendMessages, P.ReadMessageHistory, P.UseSoundboard]) {
    assert.ok(denied.has(bit), `denies ${new PermissionsBitField(bit).toArray()}`)
  }
  assert.ok(!denied.has(P.ViewChannel) && !denied.has(P.ManageChannels), 'the names stay visible and renamable')
  assert.ok(!denied.has(P.ChangeNickname), 'a server-only permission is no overwrite')
  assert.ok(!denied.has(P.CreateInstantInvite), 'nor one the bot does not hold: Discord would refuse the channel')

  // The @everyone deny binds the bot too: without Connect Discord answers Missing Access to its renames.
  assert.deepEqual(own, { id: 'bot', type: OverwriteType.Member, allow: P.ViewChannel | P.Connect, deny: 0n })
  assert.equal(lockedOverwrites('guild', 'bot', P.ViewChannel | P.ManageChannels)[1]?.allow, P.ViewChannel,
    'only what the bot holds: Discord would refuse the channel')

  // An administrator bot holds everything: still no Manage Permissions, which only administrators set in a channel.
  const all = lockedOverwrites('guild', 'bot', PermissionsBitField.All)[0]?.deny ?? 0n
  assert.ok(new PermissionsBitField(all).has([P.CreateInstantInvite, P.Connect, P.MoveMembers, P.SetVoiceChannelStatus]))
  assert.equal(all & (P.ViewChannel | P.ManageChannels | P.ManageRoles | P.Administrator), 0n)
})

test('a stats channel is renamed only when its figure changed and 5 minutes after the last rename', () => {
  const place = '🏆・Место полка: 107'
  assert.equal(renameDue(undefined, '🏆 Место полка: 107', place, 0), true, 'a name the bot never wrote: compared with the channel')
  assert.equal(renameDue(undefined, place, place, 0), false)
  const last = { name: place, at: 1000 }
  assert.equal(renameDue(last, 'Наш рейтинг', place, 2000), false, 'renamed by hand: stays until the figure changes')
  assert.equal(renameDue(last, place, '🏆・Место полка: 106', 1000 + 299), false, 'Discord allows 2 renames in 10 minutes')
  assert.equal(renameDue(last, place, '🏆・Место полка: 106', 1000 + 300), true)
})
