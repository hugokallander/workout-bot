const { Client, IntentsBitField } = require('discord.js');
const { schedule } = require('node-cron');
const moment = require('moment-timezone');
const { get } = require('http');
require('dotenv').config();

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.GuildMembers,
    ],
});

const timezoneOption = {
    timezone: 'Europe/Stockholm',
    scheduled: true
};

const GYM_CHANNEL_ID = process.env.GYM_CHANNEL_ID;
const RUN_CHANNEL_ID = process.env.RUN_CHANNEL_ID;
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID;
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;
const TOKEN = process.env.TOKEN;

// Utility functions
const getStockholmTime = () => moment.tz('Europe/Stockholm');

const nextWeekDates = () => {
    const now = getStockholmTime();
    const dates = [];
    for (let i = 7; i < 14; i++) {
        dates.push(now.clone().add(i, 'days'));
    }
    return dates;
};

const getDateForNextWeekday = (i) => {
    const now = getStockholmTime();
    const currentDayOfWeek = now.day();
    let daysUntilNextWeekday = i - currentDayOfWeek + 8;

    return now.clone().add(daysUntilNextWeekday, 'days');
};

const determineActivityTime = (day, activity) => {
    if (day < 5) {
        return activity === 'gym' ? '17:30' : '16:30';
    } else {
        return '10:00';
    }
};

const isValidSchedule = (schedule) => {
    const runDayIndices = schedule.map((day, index) => day === 'run' ? index : -1).filter(index => index !== -1);
    return runDayIndices.length === 3 && runDayIndices[1] - runDayIndices[0] > 1 && runDayIndices[2] - runDayIndices[1] > 1;
};

const totalNumParticipants = (schedule, gymSchedule, runSchedule) => schedule.reduce(
    (accumulatedParticipants, activity, dayNum) => {
        return accumulatedParticipants + (activity === 'gym' ? gymSchedule[dayNum].length : runSchedule[dayNum].length);
    },
0);

const findBestSchedule = (runDaysTarget, gymSchedule, runSchedule, numAssignedRunDays = 0, lastAssignedRunDay = -1, schedule = new Array(7).fill('gym'), maxNumParticipants = 0) => {
    if (numAssignedRunDays === runDaysTarget) {
        return schedule;
    }

    let bestSchedule = [];
    for (let runDay = lastAssignedRunDay + 1; runDay < gymSchedule.length + (numAssignedRunDays - runDaysTarget); runDay++) {
        const newSchedule = [...schedule];
        newSchedule[runDay] = 'run';
        const newFullSchedule = findBestSchedule(runDaysTarget, gymSchedule, runSchedule, numAssignedRunDays + 1, runDay, newSchedule, maxNumParticipants);
        const newNumParticipants = totalNumParticipants(newFullSchedule, gymSchedule, runSchedule);

        if (newNumParticipants > maxNumParticipants && isValidSchedule(newFullSchedule)) {
            maxNumParticipants = newNumParticipants;
            bestSchedule = newFullSchedule;
        }
    }

    return bestSchedule;
}

const getActivityDay = (activity, dayNum, gymSchedule, runSchedule) => {
    return {
        activity: activity,
        users: activity === 'gym' ? gymSchedule[dayNum] : runSchedule[dayNum],
        date: getDateForNextWeekday(dayNum).format('DD/MM'),
        time: determineActivityTime(dayNum, activity)
    };
}

const determineOptimalSchedule = (gymSchedule, runSchedule) => {
    const bestSchedule = findBestSchedule(3, gymSchedule, runSchedule);
    const weeklySchedule = bestSchedule.map((activity, i) => getActivityDay(activity, i, gymSchedule, runSchedule));

    return weeklySchedule;
};

const formatScheduleMessage = (weeklySchedule) => {
    const days = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
    let message = "";

    for (let i = 0; i < weeklySchedule.length; i++) {
        const daySchedule = weeklySchedule[i];
        const day = days[i];
        const activity = daySchedule.activity === "gym" ? "gym" : "löpning";
        const users = daySchedule.users.map(user => user.toString()).join(" ");
        const time = daySchedule.time;
        message += `- ${day} ${daySchedule.date} ${activity} kl. ${time}: ${users}\n`;
    }
    return message;
};

const fetchChannelMessages = async (channelId) => {
    const channel = client.channels.cache.get(channelId);
    return await channel.messages.fetch({ limit: 1 });
};

const fetchReactionsUsers = async (reactions) => {
    const users = [];
    for (const reaction of reactions) {
        if (reaction.emoji.name && /^[\u0031-\u0037]\uFE0F\u20E3$/.test(reaction.emoji.name)) {
            const fetchedUsers = await reaction.users.fetch();
            users[parseInt(reaction.emoji.name) - 1] = Array.from(fetchedUsers.values());
        }
    }
    return users;
};

const fetchNonResponders = async (channelId, roleName) => {
    const channel = client.channels.cache.get(channelId);
    const messages = await fetchChannelMessages(channelId);
    const message = messages.first();
    const reactions = message?.reactions.cache;
    const allMembers = await channel.guild.members.fetch();
    const responders = new Set();

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

const getActivitySchedule = async (channelId) => {
    const messages = await fetchChannelMessages(channelId);
    const reactions = messages.first()?.reactions.cache;
    
    const schedule = await fetchReactionsUsers(Array.from(reactions?.values() || []));

    return schedule;
}

const sendActivityMessage = async (activity, channelId) => {
    const dates = nextWeekDates();
    const weekNumber = dates[0].isoWeek() + 1;
    let message = `@${activity} Välj de dagar du kan ${activity}a för vecka ${weekNumber}:`;

    dates.forEach((date, i) => {
        const day = date.format('dddd DD/MM');
        message += `\n${i + 1}️⃣: ${day}`;
    });

    message += "\n🚫: kan inte denna vecka😭";

    const channel = client.channels.cache.get(channelId);
    const sentMessage = await channel.send(message);

    // React to the message with emojis 1 through 7
    for (let i = 1; i <= 7; i++) {
        await sentMessage.react(i + '️⃣');
    }

    return sentMessage;
};

const fetchLatestActivityMessage = async (channelId) => {
    const channel = client.channels.cache.get(channelId);
    const messages = await channel.messages.fetch({ limit: 1 });
    return messages.first();
};

const sendReminder = async (activity, channelId, roleName) => {
    const nonResponders = await fetchNonResponders(channelId, roleName);
    if (nonResponders.length > 0) {
        const latestActivityMessage = await fetchLatestActivityMessage(channelId);
        const reminder = `Påminnelse: Svara på veckans ${activity}-signup [här](${latestActivityMessage?.url})!\n` + nonResponders.map(member => member.toString()).join(" ");
        const reminderChannel = client.channels.cache.get(REMINDER_CHANNEL_ID);
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
    }, timezoneOption);

    // Summary messages on Fridays at noon
    schedule('0 12 * * 5', async () => {
        const gymSchedule = await getActivitySchedule(GYM_CHANNEL_ID);
        const runSchedule = await getActivitySchedule(RUN_CHANNEL_ID);

        const weeklySchedule = determineOptimalSchedule(gymSchedule, runSchedule);
        const message = formatScheduleMessage(weeklySchedule);
        const announcementChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID);
        await announcementChannel.send(message);
    }, timezoneOption);

    // Reminders for users who haven't responded
    schedule('0 12 * * 2-4', async () => {
        await sendReminder('löpnings', GYM_CHANNEL_ID, 'spring');
        await sendReminder('gym', RUN_CHANNEL_ID, 'gym');
    }, timezoneOption);

    // Daily activity reminders
    schedule('0 9 * * *', async () => {
        await sendActivityReminder();
    }, timezoneOption);
});

const sendActivityReminder = async () => {
    const reminderChannel = client.channels.cache.get(REMINDER_CHANNEL_ID);
    const announcementChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID);
    const summaryMessages = await announcementChannel.messages.fetch({ limit: 2 });

    if (summaryMessages.size > 0) {
        const now = getStockholmTime();
        const dateStr = now.format('DD/MM');

        for (const summaryMessage of summaryMessages.values()) {
            const lines = summaryMessage.content.split('\n') || [];
            for (const line of lines) {
                if (line.includes(dateStr)) {
                    const participants = line.split(':')[1].trim();
                    const reminderMessage = `Påminnelse: Dagens aktivitet (${line.split(':')[0]}): ${participants}`;
                    await reminderChannel.send(reminderMessage);
                }
            }
        }
    }
};

// Start the bot
client.login(TOKEN);