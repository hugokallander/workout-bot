const { Client, IntentsBitField } = require('discord.js');
const { schedule } = require('node-cron');
const moment = require('moment-timezone');
require('dotenv').config();

const getStockholmTime = () => moment.tz('Europe/Stockholm');

const nextWeekDates = (now) => {
    const nextWeekNumber = now.isoWeek() + 1;
    const dates = [];
    for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek++) {
        const date = now.clone().isoWeek(nextWeekNumber).isoWeekday(dayOfWeek);
        dates.push(date);
    }
    return dates;
};

const getDateForNextWeekday = (thisDayNumber, now) => {
    const currentDayOfWeek = now.day();
    let daysUntilNextWeekday = thisDayNumber - currentDayOfWeek + 8;

    return now.clone().add(daysUntilNextWeekday, 'days');
};

const isMessageRelevant = (message, currentWeekNumber) => {
    const messageDate = moment(message.createdTimestamp).tz('Europe/Stockholm');
    const messageWeekNumber = messageDate.isoWeek();
    const isCurrentWeek = messageWeekNumber === currentWeekNumber;
    const isDefault = message.content.includes('default');
    return isCurrentWeek || isDefault;
}

const includesNoCase = (text, includeString) => {
    return text.toLowerCase().includes(includeString.toLowerCase());
}

const processLine = (line, activityTimes, dayParams) => {
    const timeMatch = line.match(/(\d{2}:\d{2}|x)/);
    if (!timeMatch) return;

    dayParams.dayNames.forEach((dayName, index) => {
        const activityTime = timeMatch[0];
        if (includesNoCase(line, dayName)) {
            if (includesNoCase(line, dayParams.gymHiddenName) && !includesNoCase(line, dayParams.runHiddenName)) {
                activityTimes.gym[index] = activityTime;
            } else if (includesNoCase(line, dayParams.runHiddenName) && !includesNoCase(line, dayParams.gymHiddenName)) {
                activityTimes.run[index] = activityTime;
            } else {
                activityTimes.gym[index] = activityTime;
                activityTimes.run[index] = activityTime;
            }
            return;
        }
    });
}

const getActivityTimes = async (timeChannelId, now, dayParams) => {
    let activityTimes = { ...dayParams.defaultActivityTimes };

    const currentWeekNumber = now.isoWeek();
    const messages = await getLatestMessages(timeChannelId, 100);

    messages.forEach(message => {
        if (isMessageRelevant(message, currentWeekNumber)) {
            message.content.split('\n').forEach(line =>
                processLine(line, activityTimes, dayParams)
            );
        }
    });

    return activityTimes;
}

const isValidSchedule = (schedule, runHiddenName) => {
    const runDayIndices = schedule.map((day, index) => day === runHiddenName ? index : -1).filter(index => index !== -1);
    return (runDayIndices.length === 3) && (runDayIndices[1] - runDayIndices[0] > 1) && (runDayIndices[2] - runDayIndices[1] > 1);
};

const totalNumParticipants = (schedule, gymSchedule, runSchedule, gymHiddenName) => schedule.reduce(
    (accumulatedParticipants, activity, dayNum) => {
        return accumulatedParticipants + (activity === gymHiddenName ? gymSchedule[dayNum].length : runSchedule[dayNum].length);
    },
0);

const findBestSchedule = (runDaysTarget, gymSchedule, runSchedule, dayParams, schedule, numAssignedRunDays = 0, lastAssignedRunDay = -1, maxNumParticipants = 0) => {
    if (numAssignedRunDays === runDaysTarget) {
        return schedule;
    }

    let bestSchedule = [];
    for (let runDay = lastAssignedRunDay + 1; runDay < runSchedule.length + (numAssignedRunDays - runDaysTarget); runDay++) {
        if (runSchedule[runDay].length === 0) continue;
        const newSchedule = [...schedule];
        newSchedule[runDay] = dayParams.runHiddenName;
        const newFullSchedule = findBestSchedule(runDaysTarget, gymSchedule, runSchedule, dayParams, newSchedule, numAssignedRunDays + 1, runDay, maxNumParticipants);
        const newNumParticipants = totalNumParticipants(newFullSchedule, gymSchedule, runSchedule, dayParams.gymHiddenName);

        if (newNumParticipants > maxNumParticipants && isValidSchedule(newFullSchedule, dayParams.runHiddenName)) {
            maxNumParticipants = newNumParticipants;
            bestSchedule = newFullSchedule;
        }
    }

    return bestSchedule;
}

const getActivityObj = (activity, dayNum, gymSchedule, runSchedule, activityTime, now, gymHiddenName) => {
    return {
        activity: activity,
        users: activity === gymHiddenName ? gymSchedule[dayNum] : runSchedule[dayNum],
        date: getDateForNextWeekday(dayNum, now).format('DD/MM'),
        time: activityTime
    };
}

const determineOptimalSchedule = async (gymSchedule, runSchedule, timeChannelId, now, dayParams) => {
    const nonEmptyGymDays = gymSchedule.map(day => day.length > 0 ? dayParams.gymHiddenName : null);
    const bestSchedule = findBestSchedule(3, gymSchedule, runSchedule, dayParams, nonEmptyGymDays);
    const activityTimes = await getActivityTimes(timeChannelId, now, dayParams);
    const weeklySchedule = bestSchedule.map((activityName, dayNum) => {
        if (!activityName) {
            return null;
        }
        return getActivityObj(activityName, dayNum, gymSchedule, runSchedule, activityTimes[activityName][dayNum], now, dayParams.gymHiddenName);
    });

    return weeklySchedule;
};

const formatUsers = (users) => {
    return users
        .map(user => user.toString()).join(' ');
};

const formatScheduleMessage = (weeklySchedule, dayParams) => {
    let message = '';

    if (weeklySchedule.length === 0) {
        return 'Ingen har anmält sig den här veckan. Kom igen nu alla!!!'
    };

    for (let i = 0; i < weeklySchedule.length; i++) {
        const dayActivity = weeklySchedule[i];
        if (!dayActivity || dayActivity.users.length === 0) {
            continue;
        }

        const day = dayParams.dayNames[i];
        const activity = dayActivity.activity === dayParams.gymHiddenName ? dayParams.gymDisplayName : dayParams.runDisplayName;
        const users = formatUsers(dayActivity.users);
        const time = dayActivity.time;
        message += `- ${day} ${dayActivity.date} ${activity} kl. ${time}: ${users}\n`;
    }

    return message;
};

const getLatestMessages = async (channelId, limit, recentFirst=false) => {
    const channel = await client.channels.fetch(channelId);
    const messages = await channel.messages.fetch({ limit: limit });
    const messageArr = Array.from(messages.values())
    
    if (recentFirst) {
        return messageArr;
    }
    
    return messageArr.reverse();
};

const getLatestMessage = async (channelId) => {
    const latestMessages = await getLatestMessages(channelId, 1)
    return latestMessages[0];
};

const fetchDayResponders = async (message) => {
    const users = [];
    const refreshedMessage = await message.channel.messages.fetch(message.id);
    const reactions = refreshedMessage.reactions.cache;
    for (const reaction of reactions.values()) {
        if (reaction.emoji.name && /^[\u0031-\u0037]\uFE0F\u20E3$/.test(reaction.emoji.name)) {
            const fetchedUsers = await reaction.users.fetch();
            users[parseInt(reaction.emoji.name) - 1] = Array.from(fetchedUsers.values());
        }
    }
    return users;
};

const getActivityResponders = async (channelId) => {
    const message = await getLatestMessage(channelId);

    if (message) {
        const dayResponders = await fetchDayResponders(message);
        const dayRespondersExceptClient = dayResponders.map(users => users.filter(user => user.id !== client.user?.id));
        return dayRespondersExceptClient;
    }

    return [];
}

const getResponderSet = async (message) => {
    const responders = new Set();
    const refreshedMessage = await message.channel.messages.fetch(message.id);
    const reactions = refreshedMessage.reactions.cache;
    for (const reaction of reactions.values()) {
        const fetchedUsers = await reaction.users.fetch();
        fetchedUsers.forEach(user => responders.add(user.id));
    }
    return responders;
}

const validNonResponder = (member, roleId, responders) => {
    const memberRoles = member.roles.cache;
    
    return memberRoles.has(roleId)
        && !responders.has(member.user.id)
        && member.user.id !== client.user?.id;
}

const fetchNonRespondersFromChannel = async (channel, roleId, responders) => {
    const guild = channel.guild;
    const channelMembers = await guild.members.fetch();
    const nonResponderPromises = Array
        .from(channelMembers.values())
        .map(member => guild.members.fetch(member.id));
    const results = await Promise.all(nonResponderPromises)
    const nonResponders = results.filter(member => validNonResponder(member, roleId, responders));

    return nonResponders;
}

const fetchNonRespondersFromIds = async (channelId, roleId) => {
    const message = await getLatestMessage(channelId);
    const responders = await getResponderSet(message);
    const channel = await client.channels.fetch(channelId);
    const nonResponders = await fetchNonRespondersFromChannel(channel, roleId, responders);
    const nonRespondersExceptClient = nonResponders.filter(member => member.user.id !== client.user?.id);

    return nonRespondersExceptClient;
};

const reactToMessage = async (message, activityTimes) => {
    for (let i = 1; i <= 7; i++) {
        if (activityTimes[i - 1] === 'x') continue;
        await message.react(i + '️⃣');
    }
    await message.react('🚫');
}

const composeActivityMessage = (roleId, verbString, weekNumber, dates, activityTimes, dayNames) => {
    let message = `<@&${roleId}> Välj de dagar du kan ${verbString} för vecka ${weekNumber}:`;
    dates.forEach((date, dayNum) => {
        const time = activityTimes[dayNum];
        if (time === 'x') return;

        const dayName = dayNames[dayNum];
        const day = date.format('DD/MM');
        
        message += `\n${dayNum + 1}️⃣: ${dayName} ${day} ${time}`;
    });
    message += '\n🚫: kan inte denna vecka😭';

    return message;
}

const sendActivityMessage = async (roleId, channelId, timeChannelId, activityHiddenName, verbString, now, dayParams) => {
    const dates = nextWeekDates(now);
    const weekNumber = now.isoWeek();
    const activitiesTimes = await getActivityTimes(timeChannelId, now, dayParams);
    const activityTimes = activitiesTimes[activityHiddenName];
    const message = composeActivityMessage(roleId, verbString, weekNumber, dates, activityTimes, dayParams.dayNames);
    
    const sentMessage = await sendToChannelId(channelId, message);
    await reactToMessage(sentMessage, activityTimes);

    return sentMessage;
};

const sendReminder = async (activityName, channelId, roleId, reminderChannelId, dayNames) => {
    const nonResponders = await fetchNonRespondersFromIds(channelId, roleId);
    const latestActivityMessage = await getLatestMessage(channelId);
    const activityMessageHasDayName = dayNames.some(dayName => includesNoCase(latestActivityMessage.content, dayName));

    if (nonResponders.length > 0 && activityMessageHasDayName) {
        const nonResponderString = nonResponders.map(member => member.toString()).join(' ');
        const reminder = `Påminnelse: Svara på veckans ${activityName}-signup här: <${latestActivityMessage?.url}>\n` + nonResponderString;
        await sendToChannelId(reminderChannelId, reminder);
    }
};

const getDateMessage = async (line, runDisplayName, gymChannelId, runChannelId, now) => {
    const gymSchedule = await getActivityResponders(gymChannelId);
    const runSchedule = await getActivityResponders(runChannelId);
    const nowDay = now.day();
    const participants = line.includes(runDisplayName) ? runSchedule[nowDay] : gymSchedule[nowDay];

    if (!participants || participants.length === 0) {
        return '';
    }

    const split_line = line.split(':');
    const participantString = formatUsers(participants);

    if (split_line.length < 3) {
        return `Dagens aktivitet (${split_line[0]}): ${participantString}`;
    }
    return `Dagens aktivitet (${split_line[0]}:${split_line[1]}): ${participantString}`;
};

const sendToChannelId = async (channelId, message) => {
    if (message === '') {
        return;
    }

    const channel = await client.channels.fetch(channelId);
    const sentMessage = await channel.send(message);

    return sentMessage;
};

const getActivityLine = (message, now) => {
    const dateStr = now.format('DD/MM');
    let activityLine = '';

    const lines = message.content.split('\n');
    for (const line of lines) {
        if (line.includes(dateStr)) {
            activityLine = line;
        }
    }

    return activityLine;
}

const sendActivityReminder = async (channelIds, runDisplayName, now) => {
    const summaryMessage = await getLatestMessage(channelIds.announcement);
    const activityLine = getActivityLine(summaryMessage, now);

    if (activityLine !== '') {
        const dateMessage = await getDateMessage(activityLine, runDisplayName, channelIds.gym, channelIds.run, now);
        await sendToChannelId(channelIds.reminderOut, dateMessage);
    }
};

const sendAnnouncementMessage = async (channelIds, DAY_PARAMS) => {
    const gymSchedule = await getActivityResponders(channelIds.gym);
    const runSchedule = await getActivityResponders(channelIds.run);

    const now = getStockholmTime();
    const weeklySchedule = await determineOptimalSchedule(
        gymSchedule, runSchedule, channelIds.time, now, DAY_PARAMS);
    const message = formatScheduleMessage(weeklySchedule, DAY_PARAMS);
    await sendToChannelId(channelIds.announcementOut, message);
};

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.GuildMembers,
    ],
});

const clientReady = () => {
    const timezoneOption = {
        timezone: 'Europe/Stockholm',
        scheduled: true
    };

    const outputToTestChannel = false;

    const DAY_PARAMS = {
        dayNames: ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'],
        defaultActivityTimes: {
            gym: ['17:30', '17:30', '17:30', '17:30', '17:30', '10:00', '10:00'],
            run: ['16:30', '16:30', '16:30', '16:30', '16:30', '10:00', '10:00']
        },
        gymRoleName: 'lyft',
        runRoleName: 'spring',
        gymHiddenName: 'gym',
        runHiddenName: 'run',
        gymDisplayName: 'gym',
        runDisplayName: 'löpning',
        runVerb: 'springa',
        gymVerb: 'gymma'
    }

    let channelIds = {
        gym: process.env.GYM_CHANNEL_ID,
        run: process.env.RUN_CHANNEL_ID,
        announcement: process.env.ANNOUNCEMENT_CHANNEL_ID,
        reminder: process.env.REMINDER_CHANNEL_ID,
        time: process.env.TIME_CHANNEL_ID,
        test: process.env.TEST_CHANNEL_ID,
        runRole: process.env.RUN_ROLE_ID,
        gymRole: process.env.GYM_ROLE_ID,
        gymOut: process.env.GYM_CHANNEL_ID,
        runOut: process.env.RUN_CHANNEL_ID,
        announcementOut: process.env.ANNOUNCEMENT_CHANNEL_ID,
        reminderOut: process.env.REMINDER_CHANNEL_ID
    };

    if (outputToTestChannel) {
        channelIds.gymOut = channelIds.test;
        channelIds.runOut = channelIds.test;
        channelIds.announcementOut = channelIds.test;
        channelIds.reminderOut = channelIds.test;
    }

    await sendToChannelId(channelIds.announcementOut, "Daisy, Daisy, give me your answer do. I’m half crazy all for the love of you... It won't be a stylish marriage, I can't afford a carriage... But you'll look sweet upon the seat of a bicycle built for... two...");

    console.log(`Logged in as ${client.user?.tag}!`);

    // Weekly messages on Wednesdays at noon
    schedule('0 12 * * 3', async () => {
        try {
            const now = getStockholmTime();
            await sendActivityMessage(channelIds.gymRole, channelIds.gymOut, channelIds.time, DAY_PARAMS.gymHiddenName, DAY_PARAMS.gymVerb, now, DAY_PARAMS);
            await sendActivityMessage(channelIds.runRole, channelIds.runOut, channelIds.time, DAY_PARAMS.runHiddenName, DAY_PARAMS.runVerb, now, DAY_PARAMS);
        } catch (error) {
            console.log('Error in Wednesday schedule:', error);
        }
    }, timezoneOption);
    
    // Summary messages on Sundays at noon
    schedule('0 12 * * 7', async () => {
        try {
            sendAnnouncementMessage(channelIds, DAY_PARAMS);
        } catch (error) {
            console.log('Error in Sunday schedule:', error);
        }
    }, timezoneOption);
    
    // Reminders for users who haven't responded
    schedule('0 12 * * 4-6', async () => {
        try {
            await sendReminder('löpnings', channelIds.run, channelIds.runRole, channelIds.reminderOut, DAY_PARAMS.dayNames);
            await sendReminder('gym', channelIds.gym, channelIds.gymRole, channelIds.reminderOut, DAY_PARAMS.dayNames);
        } catch (error) {
            console.log('Error in Thursday to Saturday schedule:', error);
        }
    }, timezoneOption);
    
    // Daily activity reminders
    schedule('0 9 * * *', async () => {
        try {
            const now = getStockholmTime();
            await sendActivityReminder(channelIds, DAY_PARAMS.runDisplayName, now);
        } catch (error) {
            console.log('Error in daily activity reminder schedule:', error);
        }
    }, timezoneOption);
}

// Bot event listeners and scheduled tasks
client.once('ready', clientReady);

const TOKEN = process.env.TOKEN;

// Start the bot
client.login(TOKEN);
