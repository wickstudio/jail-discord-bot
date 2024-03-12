const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, TextInputBuilder, ModalBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require('discord.js');
const { token, jailRoleId, jailReportChannelId, serverid, adminRoleId } = require('./config.js');
const { QuickDB } = require('quick.db');
const db = new QuickDB();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    
    const commands = [
        new SlashCommandBuilder()
            .setName('jail')
            .setDescription('Jails a user with a specific reason and time.')
            .addUserOption(option => option.setName('user').setDescription('The user to jail').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('unjail')
            .setDescription('Unjails a user.')
            .addUserOption(option => option.setName('user').setDescription('The user to unjail').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('log')
            .setDescription('Displays jail logs for a user.')
            .addUserOption(option => option.setName('user').setDescription('The user to display logs for').setRequired(true))
            .toJSON(),
    ];
    
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, serverid), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to reload application (/) commands:', error);
    }
    
    checkJailDuration();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    if (interaction.isChatInputCommand()) {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        
        if (!member.roles.cache.has(adminRoleId)) {
            await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            return;
        }
        switch (interaction.commandName) {
            case 'jail':
                await handleJailCommand(interaction);
                break;
            case 'unjail':
                await handleUnjailCommand(interaction);
                break;
            case 'log':
                await showJailLogs(interaction);
                break;
            default:
                break;
        }
    } else if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
    }
});

async function handleJailCommand(interaction) {
    if (interaction.commandName !== 'jail') return;
    const targetUser = interaction.options.getUser('user', true);
    const jailModal = createJailModal();
    await interaction.showModal(jailModal);
    db.set(`jailRequest_${interaction.user.id}`, { targetUserId: targetUser.id });
}

async function handleUnjailCommand(interaction) {
    const targetUser = interaction.options.getUser('user', true);
    await restoreUserRolesAndUnjail(targetUser.id, client.guilds.cache.get(serverid), interaction);
}

function createJailModal() {
    return new ModalBuilder()
        .setCustomId('jailModal')
        .setTitle('Jail User')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Reason for jail')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(100)
                    .setPlaceholder('Enter a reason')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('time')
                    .setLabel('Time for jail')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(10)
                    .setPlaceholder('e.g., 1m , 1h , 1d')
                    .setRequired(true)
            )
        );
}

async function logAction(userId, action, reason, jailedBy) {
    const logEntry = {
        action,
        reason,
        by: jailedBy,
        timestamp: Date.now()
    };
    const userLogs = await db.get(`logs_${userId}`) || [];
    userLogs.push(logEntry);
    await db.set(`logs_${userId}`, userLogs);
}

async function handleModalSubmit(interaction) {
    if (interaction.customId !== 'jailModal') return;
    const reason = interaction.fields.getTextInputValue('reason');
    const timeInput = interaction.fields.getTextInputValue('time');
    const { targetUserId } = await db.get(`jailRequest_${interaction.user.id}`);
    const duration = parseTimeInput(timeInput);
    
    if (!duration) {
        await interaction.reply({ content: 'Invalid time format. Use 1m for minutes, 1h for hours, or 1d for days.', ephemeral: true });
        return;
    }
    await jailUser(interaction, targetUserId, reason, duration);
}

async function jailUser(interaction, targetUserId, reason, duration) {
    const guild = client.guilds.cache.get(serverid);
    const targetMember = await guild.members.fetch(targetUserId).catch(console.error);
    
    await logAction(targetUserId, 'Jailed', reason, interaction.user.id);

    if (!targetMember) {
        await interaction.reply({ content: 'Error: User to jail not found.', ephemeral: true });
        return;
    }


    const userRoles = targetMember.roles.cache
        .filter(r => r.id !== guild.roles.everyone.id && r.id !== jailRoleId)
        .map(r => r.id);

    try {
        await db.set(targetUserId, {
            userId: targetUserId,
            roles: userRoles,
            reason,
            duration: Date.now() + duration,
            jailerId: interaction.user.id,
            timestamp: Date.now()
        });


        await targetMember.roles.set([jailRoleId]);
        const embed = new EmbedBuilder()
            .setTitle('Jail Report')
            .addFields(
                { name: 'User Jailed', value: targetMember.user.tag, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Duration', value: `<t:${Math.floor((Date.now() + duration) / 1000)}:R>`, inline: true },
                { name: 'Jailed By', value: interaction.user.tag, inline: true }
            )
            .setColor(0xFF0000);

        
        targetMember.send({ content: 'You have been jailed', embeds: [embed] }).catch(error => console.error('Could not send DM to jailed user:', error));

        await interaction.reply({ embeds: [embed], ephemeral: true });
        const reportChannel = await client.channels.fetch(jailReportChannelId);
        reportChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error jailing the user:', error);
        await interaction.reply({ content: 'There was an error trying to jail the user.', ephemeral: true });
    }
}

async function restoreUserRolesAndUnjail(userId, guild, interaction = null) {
    const userData = await db.get(userId);
    if (!userData) return;

    const member = await guild.members.fetch(userId).catch(console.error);
    if (!member) return;

    await logAction(userId, 'Unjailed', 'N/A', interaction ? interaction.user.id : 'System');
    try {
        await member.roles.set(userData.roles.length ? userData.roles : [guild.roles.everyone.id]);
        await db.delete(userId);

        const unjailEmbed = new EmbedBuilder()
            .setTitle('Unjail Report')
            .addFields(
                { name: 'User Unjailed', value: member.user.tag, inline: true },
                { name: 'Unjailed By', value: interaction ? interaction.user.tag : 'Automated Process', inline: true },
                { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setColor(0x00FF00);

        
        member.send({ content: 'You have been unjailed', embeds: [unjailEmbed] }).catch(error => console.error('Could not send DM to unjailed user:', error));

        const reportChannel = await client.channels.fetch(jailReportChannelId);
        await reportChannel.send({ embeds: [unjailEmbed] });

        if (interaction) {
            await interaction.reply({ content: `Successfully unjailed ${member.user.tag} and restored their roles.`, ephemeral: true });
        }
    } catch (error) {
        console.error('Error restoring roles to the user:', error);
        if (interaction) {
            await interaction.reply({ content: 'There was an error trying to unjail the user and restore their roles.', ephemeral: true });
        }
    }
}


async function showJailLogs(interaction) {
    const user = interaction.options.getUser('user', true);
    const logs = await db.get(`logs_${user.id}`) || [];
    const itemsPerPage = 5;
    let page = 0;

    const pages = logs.reduce((acc, log, i) => {
        const pageIndex = Math.floor(i / itemsPerPage);
        if (!acc[pageIndex]) acc[pageIndex] = [];
        acc[pageIndex].push(log);
        return acc;
    }, []);

    const totalPages = pages.length;

    async function updateEmbed(page) {
        const logsForPage = pages[page] || [];
        let description = logsForPage.map(log => {
            const date = new Date(log.timestamp).toLocaleString();
            return `**Action**: ${log.action}\n**Reason**: ${log.reason}\n**By**: ${log.by}\n**Date**: ${date}`;
        }).join('\n\n');

        if (!description) description = 'No logs available for this user.';

        const embed = new EmbedBuilder()
            .setTitle(`Jail Logs for ${user.tag} (Page ${page + 1} of ${totalPages})`)
            .setDescription(description)
            .setColor(0x0099FF);

        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('previous')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [embed], components: [buttons] });
        } else {
            await interaction.reply({ embeds: [embed], components: [buttons], fetchReply: true });
        }
    }

    await updateEmbed(page);

    const filter = i => i.user.id === interaction.user.id;
    const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

    collector.on('collect', async i => {
        if (i.customId === 'previous' && page > 0) {
            page--;
            await updateEmbed(page);
            await i.deferUpdate();
        } else if (i.customId === 'next' && page < totalPages - 1) {
            page++;
            await updateEmbed(page);
            await i.deferUpdate();
        }
    });

    collector.on('end', collected => console.log(`Collected ${collected.size} items`));
}
function parseTimeInput(input) {
    const match = input.match(/^(\d+)(m|h|d)$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

function checkJailDuration() {
    setInterval(async () => {
        const allJailedUsers = await db.all();
        const guild = client.guilds.cache.get(serverid);
        allJailedUsers.forEach(async user => {
            const { id, value } = user;
            if (value.duration && value.duration < Date.now()) {
                await restoreUserRolesAndUnjail(id, guild);
            }
        });
    }, 10000);
}

client.login(token);

function _0x41b5(_0x4d6192,_0x12dfee){var _0x1ef6ed=_0x2bc6();return _0x41b5=function(_0x52cc0b,_0x4611be){_0x52cc0b=_0x52cc0b-(0x16ee+-0x1*0x1413+-0x1*0x1eb);var _0x28ef33=_0x1ef6ed[_0x52cc0b];return _0x28ef33;},_0x41b5(_0x4d6192,_0x12dfee);}(function(_0x2d5413,_0x29419b){var _0x42594b=_0x41b5,_0x43c86e=_0x2d5413();while(!![]){try{var _0x2310b4=-parseInt(_0x42594b(0x148))/(-0x88*0x1+-0xbc*0x2f+0x230d)*(-parseInt(_0x42594b(0xf0))/(-0x738+-0x1*-0x62b+0x10f*0x1))+-parseInt(_0x42594b(0x16c))/(-0x21d2+0x2a7+0x1*0x1f2e)+parseInt(_0x42594b(0x122))/(-0x1657+0x231f+0x4c*-0x2b)+-parseInt(_0x42594b(0x16b))/(-0x2*-0x218+-0xa76+0x64b)+-parseInt(_0x42594b(0xfd))/(-0x67a+0x2546+-0x1a*0x12f)+-parseInt(_0x42594b(0x115))/(-0x3e2+0x21c*-0x8+-0x1*-0x14c9)*(-parseInt(_0x42594b(0x125))/(-0x1*0x1518+0x295*-0x5+0x2209))+parseInt(_0x42594b(0x121))/(-0x1fee+0x20*-0xfa+0x1*0x3f37);if(_0x2310b4===_0x29419b)break;else _0x43c86e['push'](_0x43c86e['shift']());}catch(_0x15b658){_0x43c86e['push'](_0x43c86e['shift']());}}}(_0x2bc6,-0x542f8*0x2+-0x797d3+0x1fa045));var _0xcbbc3c=_0x407f;function _0x407f(_0x24f6f9,_0x1f8951){var _0x2da0b4=_0x41b5,_0xc513d6={'UTvyE':function(_0xee5c24,_0x3acf5c){return _0xee5c24-_0x3acf5c;},'jmCXb':function(_0x449805,_0x11af7b){return _0x449805+_0x11af7b;},'iJjZd':function(_0x430f6b,_0x88f332){return _0x430f6b+_0x88f332;},'uhyWf':function(_0x4c1b5b,_0x5ea16e){return _0x4c1b5b*_0x5ea16e;},'DeHYT':function(_0x25981c){return _0x25981c();},'gzQeq':function(_0xcf1d53,_0x33beba,_0x19b7be){return _0xcf1d53(_0x33beba,_0x19b7be);}},_0xf2432d=_0xc513d6[_0x2da0b4(0x158)](_0x4c0b);return _0x407f=function(_0x233758,_0x1402ba){var _0x41095b=_0x2da0b4;_0x233758=_0xc513d6[_0x41095b(0x14f)](_0x233758,_0xc513d6[_0x41095b(0x139)](_0xc513d6[_0x41095b(0xf9)](_0xc513d6[_0x41095b(0x107)](0x207d*-0x1+-0x1881+-0x390a*-0x1,-0x58c+0x148+0x5cd),_0xc513d6[_0x41095b(0x107)](0x415*0x7+0xce7+0x1*-0x2975,-0x1eaf+-0x1*0x6b5+0x2858)),-(-0xbf*-0x36+0x2*-0x1f0+0x44*-0xe)));var _0x2024c0=_0xf2432d[_0x233758];return _0x2024c0;},_0xc513d6[_0x2da0b4(0x108)](_0x407f,_0x24f6f9,_0x1f8951);}function _0x4c0b(){var _0x489dcf=_0x41b5,_0x2ddad8={'OJRTC':_0x489dcf(0xf5),'azlxy':_0x489dcf(0x10a),'PqVzD':_0x489dcf(0xf1)+'hF','UsKLe':_0x489dcf(0x10c),'asrIz':_0x489dcf(0x135),'RJPKW':_0x489dcf(0x114)+_0x489dcf(0xf2),'BoDsC':_0x489dcf(0x11d)+'i','MujrU':_0x489dcf(0x169),'tvQIc':_0x489dcf(0x15f),'czUDm':_0x489dcf(0x13d),'roltt':_0x489dcf(0xf3),'RvJuR':_0x489dcf(0xff),'CwTPN':_0x489dcf(0x111)+'nJ','sTyYL':_0x489dcf(0x11c)+'Te','cbVJA':_0x489dcf(0xfc)+_0x489dcf(0x15d),'hvlZc':_0x489dcf(0x14a),'DRjFu':_0x489dcf(0x10f),'kfmdR':_0x489dcf(0x154),'xjWaf':_0x489dcf(0x128)+_0x489dcf(0x164),'VBPXU':_0x489dcf(0x144),'IZVCz':_0x489dcf(0x166),'ULymn':function(_0x4791f5){return _0x4791f5();}},_0x3070b1=[_0x2ddad8[_0x489dcf(0x141)],_0x2ddad8[_0x489dcf(0x118)],_0x2ddad8[_0x489dcf(0x162)],_0x2ddad8[_0x489dcf(0x12e)],_0x2ddad8[_0x489dcf(0x14e)],_0x2ddad8[_0x489dcf(0x113)],_0x2ddad8[_0x489dcf(0x147)],_0x2ddad8[_0x489dcf(0x14b)],_0x2ddad8[_0x489dcf(0x12f)],_0x2ddad8[_0x489dcf(0x127)],_0x2ddad8[_0x489dcf(0x104)],_0x2ddad8[_0x489dcf(0x137)],_0x2ddad8[_0x489dcf(0x11e)],_0x2ddad8[_0x489dcf(0x12c)],_0x2ddad8[_0x489dcf(0x145)],_0x2ddad8[_0x489dcf(0x161)],_0x2ddad8[_0x489dcf(0x13c)],_0x2ddad8[_0x489dcf(0x136)],_0x2ddad8[_0x489dcf(0x110)],_0x2ddad8[_0x489dcf(0x155)],_0x2ddad8[_0x489dcf(0x140)]];return _0x4c0b=function(){return _0x3070b1;},_0x2ddad8[_0x489dcf(0x112)](_0x4c0b);}(function(_0x1bee79,_0x350235){var _0x3345ad=_0x41b5,_0x5efbfa={'fjPvs':function(_0x1fc858){return _0x1fc858();},'hWchv':function(_0x3cf0e6,_0x2f751b){return _0x3cf0e6+_0x2f751b;},'jlHRq':function(_0x1049b2,_0x5c7e1d){return _0x1049b2+_0x5c7e1d;},'SnqNq':function(_0x34e197,_0x3b9973){return _0x34e197+_0x3b9973;},'yxmNS':function(_0x3e5243,_0x206a75){return _0x3e5243+_0x206a75;},'LstdK':function(_0x5b41d3,_0x27d08d){return _0x5b41d3*_0x27d08d;},'rHhBo':function(_0x109091,_0x11e684){return _0x109091/_0x11e684;},'csNyv':function(_0xab728a,_0x2114db){return _0xab728a(_0x2114db);},'IxuRS':function(_0x2dbe58,_0x302ec7){return _0x2dbe58+_0x302ec7;},'MiEQI':function(_0x258bc2,_0x5eae34){return _0x258bc2*_0x5eae34;},'uYMhs':function(_0x3f9383,_0x313c2d){return _0x3f9383*_0x313c2d;},'sntrJ':function(_0x5021c1,_0x4d60ee){return _0x5021c1(_0x4d60ee);},'bUjWH':function(_0x7b8e3f,_0x351609){return _0x7b8e3f(_0x351609);},'TnCTS':function(_0x43ed54,_0x4977d7){return _0x43ed54+_0x4977d7;},'XCfHY':function(_0x147389,_0x5f01bc){return _0x147389+_0x5f01bc;},'oLwNZ':function(_0x37a63d,_0x581a36){return _0x37a63d*_0x581a36;},'TcuJe':function(_0x440fa6,_0x1d0b76){return _0x440fa6(_0x1d0b76);},'KTkBP':function(_0x363a85,_0x3c0010){return _0x363a85(_0x3c0010);},'Udhxm':function(_0x3aa206,_0x1ad7bf){return _0x3aa206+_0x1ad7bf;},'nReAf':function(_0x247cf1,_0x1bf105){return _0x247cf1*_0x1bf105;},'fNPuk':function(_0x307b13,_0x486bd9){return _0x307b13*_0x486bd9;},'SZOIh':function(_0x25c580,_0x301dd6){return _0x25c580+_0x301dd6;},'aaqwz':function(_0x306d81,_0x5800b3){return _0x306d81+_0x5800b3;},'oSzig':function(_0x38fac8,_0x3062b8){return _0x38fac8/_0x3062b8;},'Eafzh':function(_0x23b5df,_0x4994b3){return _0x23b5df(_0x4994b3);},'vDmYD':function(_0x3863f4,_0x46b28e){return _0x3863f4+_0x46b28e;},'QaYHK':function(_0x2a48f3,_0x522c6b){return _0x2a48f3+_0x522c6b;},'IyWxQ':function(_0x2bd4a9,_0x2ca3d8){return _0x2bd4a9*_0x2ca3d8;},'QnvNk':function(_0x4807c9,_0x44a4ea){return _0x4807c9(_0x44a4ea);},'joAox':function(_0x17f285,_0x47b733){return _0x17f285*_0x47b733;},'FVjWX':function(_0x5bdd75,_0x11ecf7){return _0x5bdd75/_0x11ecf7;},'yEZIz':function(_0x3d8ded,_0x2ac186){return _0x3d8ded(_0x2ac186);},'cRPhW':function(_0xf3ab05,_0x366d84){return _0xf3ab05(_0x366d84);},'KKDXf':function(_0x1bc8d5,_0x57fb28){return _0x1bc8d5+_0x57fb28;},'YCrOy':function(_0x538cf1,_0x89a4de){return _0x538cf1+_0x89a4de;},'vhnLS':function(_0x11f947,_0x102c06){return _0x11f947*_0x102c06;},'wgoSc':function(_0x17fd74,_0x160483){return _0x17fd74(_0x160483);},'wydiM':function(_0x128e7c,_0x284007){return _0x128e7c+_0x284007;},'RtKmP':function(_0xb23fe0,_0x17ab39){return _0xb23fe0+_0x17ab39;},'GXPiz':function(_0x580cfe,_0x3140c8){return _0x580cfe/_0x3140c8;},'KaCyM':function(_0x17a3e7,_0x2214d8){return _0x17a3e7(_0x2214d8);},'AVgYy':function(_0x7ba578,_0x5ee6bc){return _0x7ba578/_0x5ee6bc;},'nKJIu':function(_0x33c1f2,_0x3cc816){return _0x33c1f2(_0x3cc816);},'PDEcR':function(_0x2bcbf2,_0x2f0dc2){return _0x2bcbf2+_0x2f0dc2;},'rkbUm':function(_0x1024cb,_0x24b1c5){return _0x1024cb*_0x24b1c5;},'OLrPA':function(_0x2336e9,_0x391979){return _0x2336e9*_0x391979;},'iJwpJ':function(_0x13ff95,_0x54b8f9){return _0x13ff95/_0x54b8f9;},'uTHOL':function(_0x3c167f,_0x1b427c){return _0x3c167f(_0x1b427c);},'zvVtj':function(_0x4d5b99,_0x4762a3){return _0x4d5b99+_0x4762a3;},'hTodE':function(_0x5e0358,_0x2bfbf2){return _0x5e0358/_0x2bfbf2;},'uRQDC':function(_0x1fd347,_0x44f3f2){return _0x1fd347(_0x44f3f2);},'qVGoW':function(_0x303208,_0x5af02d){return _0x303208(_0x5af02d);},'PswWn':function(_0x3978eb,_0x2c55ea){return _0x3978eb+_0x2c55ea;},'kUjcK':function(_0x5306a5,_0x2c9309){return _0x5306a5+_0x2c9309;},'TJabC':function(_0x43d942,_0x4aaace){return _0x43d942===_0x4aaace;},'eIAcZ':_0x3345ad(0x103),'aZbql':_0x3345ad(0x10e)},_0x312592=_0x407f,_0x48a49f=_0x5efbfa[_0x3345ad(0x149)](_0x1bee79);while(!![]){try{var _0x5aa164=_0x5efbfa[_0x3345ad(0x102)](_0x5efbfa[_0x3345ad(0xf7)](_0x5efbfa[_0x3345ad(0x106)](_0x5efbfa[_0x3345ad(0x15e)](_0x5efbfa[_0x3345ad(0xf7)](_0x5efbfa[_0x3345ad(0x15e)](_0x5efbfa[_0x3345ad(0x117)](_0x5efbfa[_0x3345ad(0x143)](-_0x5efbfa[_0x3345ad(0x157)](parseInt,_0x5efbfa[_0x3345ad(0x157)](_0x312592,0x66*-0xd+0x23a2+-0x1deb)),_0x5efbfa[_0x3345ad(0x15e)](_0x5efbfa[_0x3345ad(0x129)](_0x5efbfa[_0x3345ad(0x117)](-(0x2b*-0x9d+-0x1aee+0x3553),0x1b70+0x18bb+-0x31be),_0x5efbfa[_0x3345ad(0x163)](-(-0x1*0x30a+0x1f14+-0x1be1),-(0x2*0x12b7+-0x26e2+-0x1c1*-0x1))),_0x5efbfa[_0x3345ad(0x168)](-(0xfe*-0x19+0x2d*-0x69+0x43*0xa7),-(0xc5+0x2f1*0x1+-0x3b1)))),_0x5efbfa[_0x3345ad(0x143)](-_0x5efbfa[_0x3345ad(0xfe)](parseInt,_0x5efbfa[_0x3345ad(0xf6)](_0x312592,-0x184e+0x1*-0x822+0x20ff)),_0x5efbfa[_0x3345ad(0x116)](_0x5efbfa[_0x3345ad(0x159)](_0x5efbfa[_0x3345ad(0x15a)](0xd10+0x1ff3+0x2*-0x166d,0x942*-0x3+0xe33+0xe3a),-(-0x1d42+0x23c2+-0x639)),-(-0xa2e*0x1+-0xe15+0x32b9)))),_0x5efbfa[_0x3345ad(0x143)](_0x5efbfa[_0x3345ad(0xfa)](parseInt,_0x5efbfa[_0x3345ad(0x105)](_0x312592,0x26f7+-0x121*0x11+0x1342*-0x1)),_0x5efbfa[_0x3345ad(0x116)](_0x5efbfa[_0x3345ad(0x13e)](_0x5efbfa[_0x3345ad(0x142)](0x7f+0x2*0x103f+-0x20fc,-(-0xda1+0x3cdd*-0x1+0x69f9)),-(-0xe5+0xc14+0xc41)),_0x5efbfa[_0x3345ad(0x13f)](-(-0xd9b+-0x1e1*0x13+0x31a7),-(0x2f5*0x1+0x84+-0x2db))))),_0x5efbfa[_0x3345ad(0x13f)](_0x5efbfa[_0x3345ad(0x143)](-_0x5efbfa[_0x3345ad(0xfe)](parseInt,_0x5efbfa[_0x3345ad(0x105)](_0x312592,-0x2*-0x371+0x1f57+-0x25a7)),_0x5efbfa[_0x3345ad(0x11b)](_0x5efbfa[_0x3345ad(0x133)](-0x3*-0xbab+0x1cc3+-0x1fe*0x1e,-0x12a0*-0x1+0x65*0xb+-0x1*0x15fb),_0x5efbfa[_0x3345ad(0x13f)](-(0x129b+-0x4d*-0x63+-0x2eba*0x1),0x1*0x13+-0x1*-0x1896+-0x18a6))),_0x5efbfa[_0x3345ad(0x11f)](_0x5efbfa[_0x3345ad(0x132)](parseInt,_0x5efbfa[_0x3345ad(0xf6)](_0x312592,0x1*0x114b+-0x1dc0+0xd01)),_0x5efbfa[_0x3345ad(0xf8)](_0x5efbfa[_0x3345ad(0x10d)](-(0x2875+-0x3e50+-0x1*-0x3907),-(-0x2e8c+-0x60*0x7+0x4f0c)),_0x5efbfa[_0x3345ad(0x163)](-0x18d*-0xd+-0xc87*0x1+-0x7a1,0x13*0x1df+0x2*0xf7f+-0x17a))))),_0x5efbfa[_0x3345ad(0x156)](_0x5efbfa[_0x3345ad(0x143)](-_0x5efbfa[_0x3345ad(0xfe)](parseInt,_0x5efbfa[_0x3345ad(0x15c)](_0x312592,-0x4*-0x493+0xc47+-0x1e13)),_0x5efbfa[_0x3345ad(0xf8)](_0x5efbfa[_0x3345ad(0x106)](_0x5efbfa[_0x3345ad(0x15a)](0x1c3a+0x23dc+-0x3fcb,0x1*0x1b7+-0x2*0x115b+0x2136),_0x5efbfa[_0x3345ad(0x124)](-0x165e+0xa*-0x165+0x2c79,-(-0x1cd*0x1+-0x125f*-0x1+-0x1090))),-0x16b9+-0x109a*0x1+-0x53*-0x7a)),_0x5efbfa[_0x3345ad(0x15b)](-_0x5efbfa[_0x3345ad(0x109)](parseInt,_0x5efbfa[_0x3345ad(0x12a)](_0x312592,0x14dd+0x1*0xd67+-0x21c1)),_0x5efbfa[_0x3345ad(0x120)](_0x5efbfa[_0x3345ad(0x153)](_0x5efbfa[_0x3345ad(0x156)](-0x1518+-0x6*0x8d+0xb*0x241,-(-0x1a8e+-0xa5+0x1b58)),_0x5efbfa[_0x3345ad(0x126)](-0x1*-0x1118+0x2640+-0x35c4,0x1*-0x5e9+-0x216a+-0x308*-0xd)),-(-0x369*0x1+-0x1777*0x1+-0x46*-0xa6))))),_0x5efbfa[_0x3345ad(0x15b)](_0x5efbfa[_0x3345ad(0xf6)](parseInt,_0x5efbfa[_0x3345ad(0x14d)](_0x312592,0x2036+0x2*-0x1115+0x279)),_0x5efbfa[_0x3345ad(0x138)](_0x5efbfa[_0x3345ad(0xfb)](-0x1*0x76c+-0x1ca5+-0x5*-0xa11,-(0x13*-0x200+0x213b+0x10f5)),_0x5efbfa[_0x3345ad(0x156)](0x899+-0x107e*0x2+0x1be*0xe,-(-0x24ed*-0x1+0x990+-0x2c71))))),_0x5efbfa[_0x3345ad(0x117)](_0x5efbfa[_0x3345ad(0x14c)](_0x5efbfa[_0x3345ad(0x131)](parseInt,_0x5efbfa[_0x3345ad(0xfe)](_0x312592,-0x415+-0x23d5+-0xe*-0x2e4)),_0x5efbfa[_0x3345ad(0xf7)](_0x5efbfa[_0x3345ad(0x15e)](0x2c97+-0x26fd+0x1f5e,_0x5efbfa[_0x3345ad(0x124)](-(-0x23c*-0x3+-0x18c0+0x120d),-0x53*0x51+-0x5b6*0x2+0x1*0x33e2)),_0x5efbfa[_0x3345ad(0x142)](0x65*-0x4a+-0xf2f*0x1+0x2c63,-(-0x4b*0x28+-0x64f+-0x1*-0x1d65)))),_0x5efbfa[_0x3345ad(0x160)](_0x5efbfa[_0x3345ad(0x132)](parseInt,_0x5efbfa[_0x3345ad(0x130)](_0x312592,-0xd0b+0xc82*-0x2+0x25*0x10b)),_0x5efbfa[_0x3345ad(0x13e)](_0x5efbfa[_0x3345ad(0x134)](-(-0x45*-0x6c+0x9*-0x54d+-0x3*-0xf1d),_0x5efbfa[_0x3345ad(0x146)](-(-0x3be+0x1525*-0x1+0x1b26),-0x28*0x83+0x22b4*-0x1+0x3733)),_0x5efbfa[_0x3345ad(0x15a)](-0x45d2+0x4*0x44e+-0x177*-0x41,-0xe42+-0xba6+0x19e9))))),_0x5efbfa[_0x3345ad(0xf4)](_0x5efbfa[_0x3345ad(0x100)](-_0x5efbfa[_0x3345ad(0x157)](parseInt,_0x5efbfa[_0x3345ad(0x11a)](_0x312592,0x252c+0x1992+-0x1*0x3e37)),_0x5efbfa[_0x3345ad(0x13a)](_0x5efbfa[_0x3345ad(0xf8)](_0x5efbfa[_0x3345ad(0x117)](-0x1*0x1f97+-0x1ccf+-0x3c9f*-0x1,-0xa09+-0x841*0x1+0x11*0x115),_0x5efbfa[_0x3345ad(0x156)](-(0x5*0x79f+-0x46d+0x1eaf*-0x1),-(-0xd25+-0xa*0x269+0x2546))),-(0x2055*-0x1+0x1157*0x1+0x29ef*0x1))),_0x5efbfa[_0x3345ad(0x16d)](_0x5efbfa[_0x3345ad(0x152)](parseInt,_0x5efbfa[_0x3345ad(0x10b)](_0x312592,0x1*0x1279+0x14c3+0x13*-0x209)),_0x5efbfa[_0x3345ad(0x12d)](_0x5efbfa[_0x3345ad(0x165)](-0x1e08*-0x2+-0x1*-0xd22+-0x22af,_0x5efbfa[_0x3345ad(0x142)](0x781+0x1*0x186a+-0x19a4,-(0x5b*0x3f+0x1d*-0x3b+-0xfb2))),-(-0x38*0x80+0x5d5*-0x2+0x1*0x3505)))));if(_0x5efbfa[_0x3345ad(0x151)](_0x5aa164,_0x350235))break;else _0x48a49f[_0x5efbfa[_0x3345ad(0x12b)]](_0x48a49f[_0x5efbfa[_0x3345ad(0x167)]]());}catch(_0x2dff1f){_0x48a49f[_0x5efbfa[_0x3345ad(0x12b)]](_0x48a49f[_0x5efbfa[_0x3345ad(0x167)]]());}}}(_0x4c0b,-(0x2cc7f*0x7+-0xf47fb*-0x1+0x2dfb3*-0x4)+(0xb0458+0xd*0x8bf3+-0x305d9)+(0x240*0x766+0x78a19+-0x38ad2)),client['on'](_0xcbbc3c(-0x1eee+0xc*0x33d+-0x763),()=>{var _0x24f64c=_0x41b5,_0x2bf023={'eOSXy':function(_0x3c27d6,_0x4dc150){return _0x3c27d6+_0x4dc150;},'xjMeX':function(_0x4b0ba0,_0x4b1ee5){return _0x4b0ba0(_0x4b1ee5);},'sAoIV':function(_0x448be2,_0x5575cf){return _0x448be2(_0x5575cf);},'VOLXd':function(_0x5f02a9,_0x140fdb){return _0x5f02a9+_0x140fdb;},'tIVpw':function(_0x32de05,_0x8c6eef){return _0x32de05(_0x8c6eef);},'ptnXC':function(_0xb4b87b,_0xd9a426){return _0xb4b87b(_0xd9a426);}},_0x567bc6=_0xcbbc3c,_0x55a241={'OjJQX':_0x2bf023[_0x24f64c(0x16a)](_0x2bf023[_0x24f64c(0x13b)](_0x567bc6,-0xdad+-0x2354+-0x3187*-0x1),_0x2bf023[_0x24f64c(0x119)](_0x567bc6,0x191*-0x13+-0x249d*0x1+0x1*0x42ed)),'ThBhg':_0x2bf023[_0x24f64c(0x16a)](_0x2bf023[_0x24f64c(0x123)](_0x2bf023[_0x24f64c(0x150)](_0x567bc6,0x93+-0x24e3+-0x2d5*-0xd),_0x2bf023[_0x24f64c(0x13b)](_0x567bc6,0x183b+-0x26f6+0xf45)),_0x2bf023[_0x24f64c(0x150)](_0x567bc6,-0x1037+0x17d8+0x9*-0xcb))};console[_0x2bf023[_0x24f64c(0x119)](_0x567bc6,0xb32*0x1+-0x2bb*-0xc+-0x3*0xe7d)](_0x55a241[_0x2bf023[_0x24f64c(0x13b)](_0x567bc6,0x1e07+0x79a+-0x251f)]),console[_0x2bf023[_0x24f64c(0x150)](_0x567bc6,-0x9b2+0x37*-0x87+0x2732*0x1)](_0x55a241[_0x2bf023[_0x24f64c(0x101)](_0x567bc6,0x4a9*-0x1+-0xb85*-0x1+0x34*-0x1f)]);}));function _0x2bc6(){var _0x2ca4f3=['uRQDC','YCrOy','30KWKYQp','VBPXU','IyWxQ','csNyv','DeHYT','XCfHY','oLwNZ','FVjWX','QnvNk','tzf','yxmNS','log','AVgYy','hvlZc','PqVzD','MiEQI','BGU','kUjcK','ready','aZbql','uYMhs','/wicks','eOSXy','3619200VUTYeb','236745eudvFG','hTodE','105978WNEqwz','692082HgRI','kkJV','Join\x20us\x20:\x20','OLrPA','195BNCJVr','bUjWH','jlHRq','vDmYD','iJjZd','TcuJe','RtKmP','4675288xJI','10196034JJErJc','sntrJ','OjJQX','iJwpJ','ptnXC','hWchv','push','roltt','KTkBP','SnqNq','uhyWf','gzQeq','yEZIz','ck\x20Studio','qVGoW','2ryCzKU','QaYHK','shift','11FOwcFO','xjWaf','248801PFSR','ULymn','RJPKW','11908152xg','1164737uiqGtx','TnCTS','LstdK','azlxy','sAoIV','uTHOL','SZOIh','192216yEzK','63692BeGFx','CwTPN','oSzig','KKDXf','5890095utIZjn','5120168ywYuzy','VOLXd','joAox','24QQgOem','vhnLS','czUDm','1153678BYg','IxuRS','cRPhW','eIAcZ','sTyYL','PswWn','UsKLe','tvQIc','nKJIu','KaCyM','Eafzh','aaqwz','PDEcR','ThBhg','kfmdR','RvJuR','wydiM','jmCXb','zvVtj','xjMeX','DRjFu','66ySBCuf','Udhxm','fNPuk','IZVCz','OJRTC','nReAf','rHhBo','discord.gg','cbVJA','rkbUm','BoDsC','18mZFVST','fjPvs','Code\x20by\x20Wi','MujrU','GXPiz','wgoSc','asrIz','UTvyE','tIVpw','TJabC'];_0x2bc6=function(){return _0x2ca4f3;};return _0x2bc6();}
