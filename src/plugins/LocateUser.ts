import { decorators as d, IPluginOptions, getInviteLink, logger } from "knub";
import { ZeppelinPlugin } from "./ZeppelinPlugin";
import humanizeDuration from "humanize-duration";
import { Message, Member, Guild, TextableChannel, VoiceChannel, Channel, User } from "eris";
import { GuildVCAlerts } from "../data/GuildVCAlerts";
import moment = require("moment");
import { resolveMember, sorter, createChunkedMessage, errorMessage, successMessage } from "../utils";
import * as t from "io-ts";

const ConfigSchema = t.type({
  can_where: t.boolean,
  can_alert: t.boolean,
});
type TConfigSchema = t.TypeOf<typeof ConfigSchema>;

const ALERT_LOOP_TIME = 30 * 1000;

export class LocatePlugin extends ZeppelinPlugin<TConfigSchema> {
  public static pluginName = "locate_user";
  protected static configSchema = ConfigSchema;

  private alerts: GuildVCAlerts;
  private outdatedAlertsTimeout;
  private usersWithAlerts: string[] = [];

  getDefaultOptions(): IPluginOptions<TConfigSchema> {
    return {
      config: {
        can_where: false,
        can_alert: false,
      },
      overrides: [
        {
          level: ">=50",
          config: {
            can_where: true,
            can_alert: true,
          },
        },
      ],
    };
  }

  onLoad() {
    this.alerts = GuildVCAlerts.getGuildInstance(this.guildId);
    this.outdatedAlertsLoop();
    this.fillActiveAlertsList();
  }

  async outdatedAlertsLoop() {
    const outdatedAlerts = await this.alerts.getOutdatedAlerts();

    for (const alert of outdatedAlerts) {
      await this.alerts.delete(alert.id);
      await this.removeUserIDFromActiveAlerts(alert.user_id);
    }

    this.outdatedAlertsTimeout = setTimeout(() => this.outdatedAlertsLoop(), ALERT_LOOP_TIME);
  }

  async fillActiveAlertsList() {
    const allAlerts = await this.alerts.getAllGuildAlerts();

    allAlerts.forEach(alert => {
      if (!this.usersWithAlerts.includes(alert.user_id)) {
        this.usersWithAlerts.push(alert.user_id);
      }
    });
  }

  @d.command("where", "<member:resolvedMember>", {})
  @d.permission("can_where")
  async whereCmd(msg: Message, args: { member: Member; time?: number; reminder?: string }) {
    let member = await resolveMember(this.bot, this.guild, args.member.id);
    sendWhere(this.guild, member, msg.channel, `${msg.member.mention} |`);
  }

  @d.command("vcalert", "<member:resolvedMember> [duration:delay] [reminder:string$]", {
    aliases: ["vca"],
  })
  @d.permission("can_alert")
  async vcalertCmd(msg: Message, args: { member: Member; duration?: number; reminder?: string }) {
    let time = args.duration || 600000;
    let alertTime = moment().add(time, "millisecond");
    let body = args.reminder || "None";

    this.alerts.add(msg.author.id, args.member.id, msg.channel.id, alertTime.format("YYYY-MM-DD HH:mm:ss"), body);
    if (!this.usersWithAlerts.includes(args.member.id)) {
      this.usersWithAlerts.push(args.member.id);
    }

    msg.channel.createMessage(
      `If ${args.member.mention} joins or switches VC in the next ${humanizeDuration(time)} i will notify you`,
    );
  }

  @d.command("vcalerts")
  @d.permission("can_alert")
  async listVcalertCmd(msg: Message) {
    const alerts = await this.alerts.getAlertsByRequestorId(msg.member.id);
    if (alerts.length === 0) {
      this.sendErrorMessage(msg.channel, "You have no active alerts!");
      return;
    }

    alerts.sort(sorter("expires_at"));
    const longestNum = (alerts.length + 1).toString().length;
    const lines = Array.from(alerts.entries()).map(([i, alert]) => {
      const num = i + 1;
      const paddedNum = num.toString().padStart(longestNum, " ");
      return `\`${paddedNum}.\` \`${alert.expires_at}\` Member: <@!${alert.user_id}> Reminder: \`${alert.body}\``;
    });
    createChunkedMessage(msg.channel, lines.join("\n"));
  }

  @d.command("vcalerts delete", "<num:number>", {
    aliases: ["vcalerts d"],
  })
  @d.permission("can_alert")
  async deleteVcalertCmd(msg: Message, args: { num: number }) {
    const alerts = await this.alerts.getAlertsByRequestorId(msg.member.id);
    alerts.sort(sorter("expires_at"));
    const lastNum = alerts.length + 1;

    if (args.num > lastNum || args.num < 0) {
      msg.channel.createMessage(errorMessage("Unknown alert"));
      return;
    }

    const toDelete = alerts[args.num - 1];
    await this.alerts.delete(toDelete.id);

    msg.channel.createMessage(successMessage("Alert deleted"));
  }

  @d.event("voiceChannelJoin")
  async userJoinedVC(member: Member, channel: Channel) {
    if (this.usersWithAlerts.includes(member.id)) {
      this.sendAlerts(member.id);
      await this.removeUserIDFromActiveAlerts(member.id);
    }
  }

  @d.event("voiceChannelSwitch")
  async userSwitchedVC(member: Member, newChannel: Channel, oldChannel: Channel) {
    if (this.usersWithAlerts.includes(member.id)) {
      this.sendAlerts(member.id);
      await this.removeUserIDFromActiveAlerts(member.id);
    }
  }

  @d.event("guildBanAdd")
  async onGuildBanAdd(_, user: User) {
    const alerts = await this.alerts.getAlertsByUserId(user.id);
    alerts.forEach(alert => {
      this.alerts.delete(alert.id);
    });
  }

  async sendAlerts(userid: string) {
    const triggeredAlerts = await this.alerts.getAlertsByUserId(userid);
    const member = await resolveMember(this.bot, this.guild, userid);

    triggeredAlerts.forEach(alert => {
      let prepend = `<@!${alert.requestor_id}>, an alert requested by you has triggered!\nReminder: \`${
        alert.body
      }\`\n`;
      sendWhere(this.guild, member, <TextableChannel>this.bot.getChannel(alert.channel_id), prepend);
      this.alerts.delete(alert.id);
    });
  }

  async removeUserIDFromActiveAlerts(userid: string) {
    const index = this.usersWithAlerts.indexOf(userid);
    if (index > -1) {
      this.usersWithAlerts.splice(index, 1);
    }
  }
}

export async function sendWhere(guild: Guild, member: Member, channel: TextableChannel, prepend: string) {
  let voice = await (<VoiceChannel>guild.channels.get(member.voiceState.channelID));

  if (voice == null) {
    channel.createMessage(prepend + "That user is not in a channel");
  } else {
    let invite = await createInvite(voice);
    channel.createMessage(
      prepend + ` ${member.mention} is in the following channel: ${voice.name} https://${getInviteLink(invite)}`,
    );
  }
}

export async function createInvite(vc: VoiceChannel) {
  let existingInvites = await vc.getInvites();

  if (existingInvites.length !== 0) {
    return existingInvites[0];
  } else {
    return vc.createInvite(undefined);
  }
}