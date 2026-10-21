import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js'
import { lockedOverwrites } from './squadron-stats.js'

test('a stats channel at the top of the list is viewed by everyone and closed for everything else the bot can deny', () => {
  // Test pechenka's bot: @everyone's server permissions plus View Channel and Manage Channels on its role.
  const everyone = P.SendMessages | P.ReadMessageHistory | P.AddReactions | P.Connect | P.Speak | P.Stream
    | P.UseVAD | P.UseSoundboard | P.UseEmbeddedActivities | P.SendVoiceMessages | P.ChangeNickname
  const [overwrite] = lockedOverwrites('guild', everyone | P.ViewChannel | P.ManageChannels)
  assert.equal(overwrite?.id, 'guild', 'the @everyone overwrite')
  assert.equal(overwrite.allow, P.ViewChannel)
  const denied = new PermissionsBitField(overwrite.deny)
  for (const bit of [P.Connect, P.Speak, P.Stream, P.SendMessages, P.ReadMessageHistory, P.UseSoundboard]) {
    assert.ok(denied.has(bit), `denies ${new PermissionsBitField(bit).toArray()}`)
  }
  assert.ok(!denied.has(P.ViewChannel) && !denied.has(P.ManageChannels), 'the names stay visible and renamable')
  assert.ok(!denied.has(P.ChangeNickname), 'a server-only permission is no overwrite')
  assert.ok(!denied.has(P.CreateInstantInvite), 'nor one the bot does not hold: Discord would refuse the channel')

  // An administrator bot holds everything: still no Manage Permissions, which only administrators set in a channel.
  const all = lockedOverwrites('guild', PermissionsBitField.All)[0]?.deny ?? 0n
  assert.ok(new PermissionsBitField(all).has([P.CreateInstantInvite, P.Connect, P.MoveMembers, P.SetVoiceChannelStatus]))
  assert.equal(all & (P.ViewChannel | P.ManageChannels | P.ManageRoles | P.Administrator), 0n)
})
