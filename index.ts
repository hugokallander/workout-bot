import { Client, IntentsBitField, TextChannel, MessageReaction, User } from 'discord.js';
import { schedule } from 'node-cron';
import * as moment from 'moment-timezone';
require('dotenv').config();

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.GuildMembers,
    ],
});

const GYM_CHANNEL_ID = process.env.GYM_CHANNEL_ID;
const RUN_CHANNEL_ID = process.env.RUN_CHANNEL_ID;
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID;
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;
const TOKEN = process.env.TOKEN;

// Utility functions
const getStockholmTime = () => moment.tz('Europe/Stockholm');

const nextWeekDates = () => {
    const now = getStockholmTime();
    const dates: moment.Moment[] = [];
    for (let i = 7; i < 14; i++) {
        dates.push(now.clone().add(i, 'days'));
    }
    return dates;
};

const determineActivityTime = (day: string, activity: string) => {
    const weekdays = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag"];
    if (weekdays.includes(day)) {
        return activity === 'gym' ? '17:30' : '16:30';
    } else {
        return '10:00';
    }
};

const determineOptimalSchedule = (gymSchedule: User[][], runSchedule: User[][]) => {
    const days = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
    const schedule: { day: string, activity: string, users: User[], date: moment.Moment, time: string }[] = [];
    let runDays = 0;

    const sortedDays = days.map((day, i) => {
        return {
            day: day,
            gymUsers: gymSchedule[i],
            runUsers: runSchedule[i],
            totalUsers: gymSchedule[i].length + runSchedule[i].length,
            date: nextWeekDates()[i]
        };
    }).sort((a, b) => b.totalUsers - a.totalUsers);

    for (let i = 0; i < sortedDays.length; i++) {
        const prevDay = schedule[i - 1];
        const nextDay = schedule[i + 1];
        
        if (runDays < 3 && (!prevDay || prevDay.activity !== 'run') && (!nextDay || nextDay.activity !== 'run')) {
            schedule.push({
                day: sortedDays[i].day,
                activity: 'run',
                users: sortedDays[i].runUsers,
                date: sortedDays[i].date,
                time: determineActivityTime(sortedDays[i].day, 'run')
            });
            runDays++;
        } else {
            schedule.push({
                day: sortedDays[i].day,
                activity: 'gym',
                users: sortedDays[i].gymUsers,
                date: sortedDays[i].date,
                time: determineActivityTime(sortedDays[i].day, 'gym')
            });
        }
    }

    return schedule;
};

const formatScheduleMessage = (weeklySchedule: any[]) => {
    const days = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
    let message = "";

    for (let i = 0; i < weeklySchedule.length; i++) {
        const daySchedule = weeklySchedule[i];
        const day = days[i];
        const activity = daySchedule.activity === "gym" ? "gym" : "löpning";
        const users = daySchedule.users.map((user: User) => user.toString()).join(" ");
        const time = daySchedule.time;
        message += `- ${day} ${daySchedule.date} ${activity} kl. ${time}: ${users}\n`;
    }
    return message;
};

const fetchChannelMessages = async (channelId: string) => {
    const channel = client.channels.cache.get(channelId) as TextChannel;
    return await channel.messages.fetch({ limit: 1 });
};

const fetchReactionsUsers = async (reactions: MessageReaction[]) => {
    const users: User[][] = [];
    for (const reaction of reactions) {
        if (reaction.emoji.name && /^[1-7]$/.test(reaction.emoji.name)) {
            const fetchedUsers = await reaction.users.fetch();
            users[parseInt(reaction.emoji.name) - 1] = Array.from(fetchedUsers.values());
        }
    }
    return users;
};

const fetchNonResponders = async (channelId: string, roleName: string) => {
    const channel = client.channels.cache.get(channelId) as TextChannel;
    const messages = await fetchChannelMessages(channelId);
    const message = messages.first();
    const reactions = message?.reactions.cache;
    const allMembers = await channel.guild.members.fetch();
    const responders: Set<string> = new Set();

    if (reactions) {
        for (const reaction of reactions.values()) {
            const users = await reaction.users.fetch();
            users.forEach(user => responders.add(user.id));
        }
    }

    const role = channel.guild.roles.cache.find(role => role.name === roleName);
    const members = role?.members || new Map();
    return Array.from(members.values()).filter(member => !responders.has(member.id) && member.id !== client.user?.id);
};

const getActivitySchedule = async (channelId: string) => {
    const messages = await fetchChannelMessages(channelId);
    const reactions = messages.first()?.reactions.cache;
    
    const schedule = await fetchReactionsUsers(Array.from(reactions?.values() || []));

    return schedule;
}

const sendActivityMessage = async (activity: string, channelId: string) => {
    const dates = nextWeekDates();
    const weekNumber = dates[0].isoWeek() + 1;
    let message = `@${activity} Välj de dagar du kan ${activity}a för vecka ${weekNumber}:`;

    dates.forEach((date, i) => {
        const day = date.format('dddd DD/MM');
        message += `\n${i + 1}️⃣: ${day}`;
    });

    message += "\n🚫: kan inte denna vecka😭";

    const channel = client.channels.cache.get(channelId) as TextChannel;
    const sentMessage = await channel.send(message);

    // React to the message with emojis 1 through 7
    for (let i = 1; i <= 7; i++) {
        await sentMessage.react(i + '️⃣');
    }

    return sentMessage;
};

const fetchLatestActivityMessage = async (channelId: string) => {
    const channel = client.channels.cache.get(channelId) as TextChannel;
    const messages = await channel.messages.fetch({ limit: 1 });
    return messages.first();
};

const sendReminder = async (activity: string, channelId: string, roleName: string) => {
    const nonResponders = await fetchNonResponders(channelId, roleName);
    if (nonResponders.length > 0) {
        const latestActivityMessage = await fetchLatestActivityMessage(channelId);
        const reminder = `Påminnelse: Svara på veckans ${activity}-signup [här](${latestActivityMessage?.url})!\n` + nonResponders.map(member => member.toString()).join(" ");
        const reminderChannel = client.channels.cache.get(REMINDER_CHANNEL_ID) as TextChannel;
        await reminderChannel.send(reminder);
    }
};

// Bot event listeners and scheduled tasks
client.once('ready', () => {
    console.log(`Logged in as ${client.user?.tag}!`);

    // Weekly messages on Mondays at noon
    schedule('0 12 * * 1', async () => {
        await sendActivityMessage('gym', GYM_CHANNEL_ID);
        await sendActivityMessage('spring', RUN_CHANNEL_ID);
    });

    // Summary messages on Fridays at noon
    schedule('0 12 * * 5', async () => {
        const gymSchedule = await getActivitySchedule(GYM_CHANNEL_ID);
        const runSchedule = await getActivitySchedule(RUN_CHANNEL_ID);

        const weeklySchedule = determineOptimalSchedule(gymSchedule, runSchedule);
        const message = formatScheduleMessage(weeklySchedule);
        const announcementChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID) as TextChannel;
        await announcementChannel.send(message);
    });

    // Reminders for users who haven't responded
    schedule('0 12 * * 2-4', async () => {
        await sendReminder('löpnings', GYM_CHANNEL_ID, 'spring');
        await sendReminder('gym', RUN_CHANNEL_ID, 'gym');
    });

    // Daily activity reminders
    schedule('0 9 * * *', async () => {
        await sendActivityReminder();
    });
});

const sendActivityReminder = async () => {
    const reminderChannel = client.channels.cache.get(REMINDER_CHANNEL_ID) as TextChannel;
    const announcementChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID) as TextChannel;
    const summaryMessages = await announcementChannel.messages.fetch({ limit: 1 });

    if (summaryMessages.size > 0) {
        const summaryMessage = summaryMessages.first()?.content.split('\n') || [];
        const now = getStockholmTime();
        const dateStr = now.format('DD/MM');

        for (const line of summaryMessage) {
            if (line.includes(dateStr)) {
                const participants = line.split(':')[1].trim();
                const reminderMessage = `Påminnelse: Dagens aktivitet (${line.split(':')[0]}): ${participants}`;
                await reminderChannel.send(reminderMessage);
            }
        }
    }
};

// Start the bot
client.login(TOKEN);
