const { Client, IntentsBitField } = require('discord.js');
const { schedule } = require('node-cron');
const moment = require('moment-timezone');
require('dotenv').config();

const getStockholmTime = () => moment.tz('Europe/Stockholm');

const nextWeekDates = () => {
    const now = getStockholmTime();
    const nextWeekNumber = now.isoWeek() + 1;
    const dates = [];
    for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek++) {
        const date = now.clone().isoWeek(nextWeekNumber).isoWeekday(dayOfWeek);
        dates.push(date);
    }
    return dates;
};

const getDateForNextWeekday = (i) => {
    const now = getStockholmTime();
    const currentDayOfWeek = now.day();
    let daysUntilNextWeekday = i - currentDayOfWeek + 8;

    return now.clone().add(daysUntilNextWeekday, 'days');
};

function getCurrentAndPreviousWeekNumbers() {
    const now = getStockholmTime();
    const currentWeekNumber = now.isoWeek();
    const previousWeekNumber = currentWeekNumber - 1;
    return { currentWeekNumber, previousWeekNumber };
}

function isMessageRelevant(message, currentWeekNumber, previousWeekNumber) {
    const messageDate = moment(message.createdTimestamp).tz('Europe/Stockholm');
    const messageWeekNumber = messageDate.isoWeek();
    const isCurrentOrPreviousWeek = messageWeekNumber === currentWeekNumber || messageWeekNumber === previousWeekNumber;
    const isDefault = message.content.includes("default");
    return isCurrentOrPreviousWeek || isDefault;
}

function processLine(line, dayNames, activityTimes) {
    const timeMatch = line.match(/(\d{2}:\d{2}|x)/);
    dayNames.forEach((dayName, index) => {
        if (line.toLowerCase().includes(dayName.toLowerCase())) {
            if (timeMatch) {
                if (line.includes("gym") && !line.includes("run")) {
                    activityTimes.gym[index] = timeMatch[0];
                } else if (line.includes("run") && !line.includes("gym")) {
                    activityTimes.run[index] = timeMatch[0];
                } else {
                    activityTimes.gym[index] = timeMatch[0];
                    activityTimes.run[index] = timeMatch[0];
                }
            }
        }
    });
}

async function getActivityTimes(timeChannelId, dayNames) {
    let activityTimes = {
        gym: ["17:30", "17:30", "17:30", "17:30", "17:30", "10:00", "10:00"],
        run: ["16:30", "16:30", "16:30", "16:30", "16:30", "10:00", "10:00"]
    };

    const { currentWeekNumber, previousWeekNumber } = getCurrentAndPreviousWeekNumbers();
    const channel = client.channels.cache.get(timeChannelId);
    const messages = await channel.messages.fetch({ limit: 100 });

    messages.forEach(message => {
        if (isMessageRelevant(message, currentWeekNumber, previousWeekNumber)) {
            message.content.split('\n').forEach(line => {
                processLine(line, dayNames, activityTimes);
            });
        }
    });

    return activityTimes;
}

const isValidSchedule = (schedule) => {
    const runDayIndices = schedule.map((day, index) => day === 'run' ? index : -1).filter(index => index !== -1);
    return runDayIndices.length === 3 && runDayIndices[1] - runDayIndices[0] > 1 && runDayIndices[2] - runDayIndices[1] > 1;
};

const totalNumParticipants = (schedule, gymSchedule, runSchedule) => schedule.reduce(
    (accumulatedParticipants, activity, dayNum) => {
        return accumulatedParticipants + (activity === 'gym' ? gymSchedule[dayNum].length : runSchedule[dayNum].length);
    },
0);

const findBestSchedule = (runDaysTarget, gymSchedule, runSchedule, schedule = new Array(7).fill('gym'), numAssignedRunDays = 0, lastAssignedRunDay = -1, maxNumParticipants = 0) => {
    if (numAssignedRunDays === runDaysTarget) {
        return schedule;
    }

    let bestSchedule = [];
    for (let runDay = lastAssignedRunDay + 1; runDay < runSchedule.length + (numAssignedRunDays - runDaysTarget); runDay++) {
        if (runSchedule[runDay].length === 0) continue;
        const newSchedule = [...schedule];
        newSchedule[runDay] = 'run';
        const newFullSchedule = findBestSchedule(runDaysTarget, gymSchedule, runSchedule, newSchedule, numAssignedRunDays + 1, runDay, maxNumParticipants);
        const newNumParticipants = totalNumParticipants(newFullSchedule, gymSchedule, runSchedule);

        if (newNumParticipants > maxNumParticipants && isValidSchedule(newFullSchedule)) {
            maxNumParticipants = newNumParticipants;
            bestSchedule = newFullSchedule;
        }
    }

    return bestSchedule;
}

const getActivityObj = (activity, dayNum, gymSchedule, runSchedule, activityTime) => {
    return {
        activity: activity,
        users: activity === 'gym' ? gymSchedule[dayNum] : runSchedule[dayNum],
        date: getDateForNextWeekday(dayNum).format('DD/MM'),
        time: activityTime
    };
}

const determineOptimalSchedule = async (gymSchedule, runSchedule, timeChannelId, dayNames) => {
    const nonEmptyGymDays = gymSchedule.map(day => day.length > 0 ? "gym" : null);
    const bestSchedule = findBestSchedule(3, gymSchedule, runSchedule, nonEmptyGymDays);
    const activityTimes = await getActivityTimes(timeChannelId, dayNames);
    const weeklySchedule = bestSchedule.map((activityName, dayNum) => {
        if (!activityName) {
            return null;
        }
        return getActivityObj(activityName, dayNum, gymSchedule, runSchedule, activityTimes[activityName][dayNum])
    });

    return weeklySchedule;
};

const formatScheduleMessage = (weeklySchedule, dayNames) => {
    let message = "";

    for (let i = 0; i < weeklySchedule.length; i++) {
        const dayActivity = weeklySchedule[i];
        if (!dayActivity) {
            continue;
        }

        const day = dayNames[i];
        const activity = dayActivity.activity === "gym" ? "gym" : "löpning";
        const users = dayActivity.users.map(user => user.toString()).join(" ");
        const time = dayActivity.time;
        message += `- ${day} ${dayActivity.date} ${activity} kl. ${time}: ${users}\n`;
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

const sendActivityMessage = async (activity, roleName, channelId, dayNames, timeChannelId) => {
    const dates = nextWeekDates();
    const weekNumber = dates[0].isoWeek();
    const activitiesTimes = await getActivityTimes(timeChannelId, dayNames);
    const activityTimes = activitiesTimes[activity];
    const channel = client.channels.cache.get(channelId);
    const role = channel.guild.roles.cache.find(role => role.name === roleName);
    const roleId = role.id;
    let message = `<@&${roleId}> Välj de dagar du kan ${roleName}a för vecka ${weekNumber}:`;

    dates.forEach((date, dayNum) => {
        const time = activityTimes[dayNum];
        if (time === 'x') return;

        const dayName = dayNames[dayNum];
        const day = date.format('DD/MM');
        
        message += `\n${dayNum + 1}️⃣: ${dayName} ${day} ${time}`;
    });

    message += "\n🚫: kan inte denna vecka😭";

    const sentMessage = await channel.send(message);

    // React to the message with emojis 1 through 7
    for (let i = 1; i <= 7; i++) {
        if (activityTimes[i - 1] === 'x') continue;
        await sentMessage.react(i + '️⃣');
    }

    return sentMessage;
};

const fetchLatestActivityMessage = async (channelId) => {
    const channel = client.channels.cache.get(channelId);
    const messages = await channel.messages.fetch({ limit: 1 });
    return messages.first();
};

const sendReminder = async (activity, channelId, roleName, reminderChannelId) => {
    const nonResponders = await fetchNonResponders(channelId, roleName);
    if (nonResponders.length > 0) {
        const latestActivityMessage = await fetchLatestActivityMessage(channelId);
        const reminder = `Påminnelse: Svara på veckans ${activity}-signup [här](${latestActivityMessage?.url})!\n` + nonResponders.map(member => member.toString()).join(" ");
        const reminderChannel = client.channels.cache.get(reminderChannelId);
        await reminderChannel.send(reminder);
    }
};

const sendActivityReminder = async (reminderChannelId, announcementChannelId) => {
    const reminderChannel = client.channels.cache.get(reminderChannelId);
    const announcementChannel = client.channels.cache.get(announcementChannelId);
    const summaryMessages = await announcementChannel.messages.fetch({ limit: 10 });
    let dateMessages = {};

    if (summaryMessages.size > 0) {
        const now = getStockholmTime();
        const dateStr = now.format('DD/MM');

        for (const summaryMessage of summaryMessages.values()) {
            const lines = summaryMessage.content.split('\n') || [];
            for (const line of lines) {
                if (line.includes(dateStr)) {
                    const participants = line.split(':')[1].trim();
                    dateMessages[dateStr] = `Påminnelse: Dagens aktivitet (${line.split(':')[0]}): ${participants}`;
                }
            }
        }
    }

    for (const dateMessage of Object.values(dateMessages)) {
        await reminderChannel.send(dateMessage);
    }
};

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.GuildMembers,
    ],
});

// Bot event listeners and scheduled tasks
client.once('ready', () => {
    
    const timezoneOption = {
        timezone: 'Europe/Stockholm',
        scheduled: true
    };
    
    const GYM_CHANNEL_ID = process.env.GYM_CHANNEL_ID;
    const RUN_CHANNEL_ID = process.env.RUN_CHANNEL_ID;
    const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID;
    const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;
    const TIME_CHANNEL_ID = process.env.TIME_CHANNEL_ID;
    const TEST_CHANNEL_ID = process.env.TEST_CHANNEL_ID;
    const DAY_NAMES = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
    const outputToTestChannel = false;

    let GYM_CHANNEL_ID_OUT = GYM_CHANNEL_ID;
    let RUN_CHANNEL_ID_OUT = RUN_CHANNEL_ID;
    let ANNOUNCEMENT_CHANNEL_ID_OUT = ANNOUNCEMENT_CHANNEL_ID;
    let REMINDER_CHANNEL_ID_OUT = REMINDER_CHANNEL_ID;

    if (outputToTestChannel) {
        GYM_CHANNEL_ID_OUT = TEST_CHANNEL_ID;
        RUN_CHANNEL_ID_OUT = TEST_CHANNEL_ID;
        ANNOUNCEMENT_CHANNEL_ID_OUT = TEST_CHANNEL_ID;
        REMINDER_CHANNEL_ID_OUT = TEST_CHANNEL_ID;
    }
    

    console.log(`Logged in as ${client.user?.tag}!`);

    // Weekly messages on Mondays at noon
    schedule('0 12 * * 1', async () => {
        await sendActivityMessage('gym', 'lyft', GYM_CHANNEL_ID_OUT, DAY_NAMES, TIME_CHANNEL_ID);
        await sendActivityMessage('run', 'spring', RUN_CHANNEL_ID_OUT, DAY_NAMES, TIME_CHANNEL_ID);
    }, timezoneOption);

    // Summary messages on Fridays at noon
    schedule('0 12 * * 5', async () => {
        const gymSchedule = await getActivitySchedule(GYM_CHANNEL_ID);
        const runSchedule = await getActivitySchedule(RUN_CHANNEL_ID);

        const weeklySchedule = await determineOptimalSchedule(
            gymSchedule, runSchedule, TIME_CHANNEL_ID, DAY_NAMES);
        const message = formatScheduleMessage(weeklySchedule, DAY_NAMES);
        const announcementChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID_OUT);
        await announcementChannel.send(message);
    }, timezoneOption);

    // Reminders for users who haven't responded
    schedule('0 12 * * 2-4', async () => {
        await sendReminder('löpnings', RUN_CHANNEL_ID, 'spring', REMINDER_CHANNEL_ID_OUT);
        await sendReminder('gym', GYM_CHANNEL_ID, 'gym', REMINDER_CHANNEL_ID_OUT);
    }, timezoneOption);

    // Daily activity reminders
    schedule('0 9 * * *', async () => {
        await sendActivityReminder(REMINDER_CHANNEL_ID_OUT, ANNOUNCEMENT_CHANNEL_ID);
    }, timezoneOption);
});

const TOKEN = process.env.TOKEN;

// Start the bot
client.login(TOKEN);