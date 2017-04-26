/**
 * # Treatment conditions for meritocracy game.
 * Copyright(c) 2017 Stefano Balietti
 * MIT Licensed
 *
 * Contains helper functions to create Gaussian noise.
 *
 * http://www.nodegame.org
 * ---
 */

var J = require('JSUS').JSUS;

var ngc = require('nodegame-client');

// Share through channel.require.
var channel = module.parent.exports.channel;
var node = module.parent.exports.node;
var settings = module.parent.exports.settings;

var SUBGROUP_SIZE = settings.SUBGROUP_SIZE;
var treatment = settings.treatmentName;
var groupNames = settings.GROUP_NAMES;

module.exports = {
    sendResults: sendResults
};

// Noise variance. High and low stands for "meritocracy", not for noise.
var NOISE_HIGH = settings.NOISE_HIGH;
var NOISE_LOW = settings.NOISE_LOW;

var GROUP_ACCOUNT_DIVIDER = settings.GROUP_ACCOUNT_DIVIDER;

// Number of coins for each player at the beginning of each round
var INITIAL_COINS = settings.INITIAL_COINS;

// Functions used in map-reduce.

function averageContribution(pv, cv) {
    return pv + cv.contribution;
}

function averageDemand(pv, cv) {
    return pv + cv.demand;
}

function computeGroupAccount(prev, curr) {
    return prev + curr[0];
}

// If two contributions are exactly the same, then they are randomly ordered.
function sortContributions(c1, c2) {
    if (c1.contribution > c2.contribution) return -1;
    if (c1.contribution < c2.contribution) return 1;
    if (Math.random() <= 0.5) return -1;
    return 1;
}

// If two contributions are exactly the same, then they are randomly ordered.
function sortNoisyContributions(c1, c2) {
    if (c1.noisyContribution > c2.noisyContribution) return -1;
    if (c1.noisyContribution < c2.noisyContribution) return 1;
    if (Math.random() <= 0.5) return -1;
    return 1;
}

/**
 * Returns payoff
 *
 * @param  {array} contributions Array of contribution values by group
 * @param  {array} position     position of current player
 * @param  {object} currentStage current stage
 * @return {int}              payoff
 */
function getPayoff(bars, position) {
    var payoff, group;
    group = bars[position[0]];
    payoff = group.reduce(computeGroupAccount, 0);
    payoff = payoff / GROUP_ACCOUNT_DIVIDER;
    payoff = INITIAL_COINS - group[position[1]][0] + payoff;
    return payoff;
}

/**
 * Splits a sorted array of contributions objects into four groups
 *
 * Computes the ranking, i.e. the list of player ids from top to bottom.
 *
 * @param {array} ranking The sorted array of contribution objects
 * @return {object} Object containing the ranking and groups
 */
function doGroupMatching(sortedContribs) {
    var i, len, groups, entry, ranking, bars;
    var gId;
    len = sortedContribs.length;
    groups = [];
    ranking = [];
    bars = [];
    gId = -1;
    for (i = 0; i < len; i++) {
        if (i % SUBGROUP_SIZE == 0) {
            ++gId;
            groups[gId] = [];
            bars[gId] = [];
        }
        entry = sortedContribs[i];
        entry.group = groupNames[gId];
        groups[gId].push(entry);
        ranking.push(entry.player);
        bars[gId].push([entry.contribution, entry.demand]);
    }
    return {
        groups: groups,
        ranking: ranking,
        bars: bars
    };
}

function computeGroupStats(groups) {
    var i, len, group;
    var j, lenJ, entry;
    var out, groupName;

    var cSumSquared, dSumSquared, cSum, dSum, df;
    out = {};
    i = -1, len = groups.length;
    for (; ++i < len;) {
        group = groups[i];
        groupName = groupNames[i];
        j = -1, lenJ = group.length;

        cSum = 0,
        cSumSquared = 0;

        dSum = 0;
        dSumSquared = 0;

        for (; ++j < lenJ;) {
            entry = groups[i][j];

            cSum += entry.contribution;
            cSumSquared = Math.pow(entry.contribution, 2);

            if (ENDO) {
                dSum += entry.demand;
                dSumSquared = Math.pow(entry.demand, 2);
            }
        }

        df = lenJ - 1;

        out[groupName] = {
            avgContr: cSum / lenJ,
            stdContr: df <= 1 ? 'NA' : 
                Math.sqrt((cSumSquared - (Math.pow(cSum, 2) / lenJ)) / df)
        };

        if (ENDO) {
            out[groupName].avgDemand = dSum / lenJ;
            out[groupName].stdDemand = df <= 1 ? 'NA' :
                Math.sqrt((dSumSquared - (Math.pow(dSum, 2) / lenJ)) / df);
        }
        else {
            out[groupName].avgDemand = 'NA';
            out[groupName].stdDemand = 'NA';
        }
    }
    return out;
}

/**
 * Send and saves received values for each player.
 */
function emitPlayersResults(pId, bars, position, payoff, compatibility) {
    var finalBars;
    finalBars = [bars, position, payoff, compatibility];
    node.say('results', pId, finalBars);
}

// Saves the outcome of a round to database, and communicates it to the clients.
function finalizeRound(currentStage, bars,
                       groupStats, groups, ranking, noisyGroupStats,
                       noisyGroups, noisyRanking, compatibility) {

    var i, len, j, lenJ, contribObj;
    var pId, positionInNoisyRank, playerPayoff;
    var code;

    if (settings.DB === 'MONGODB') {
        // Save the results at the group level.
        node.game.saveRoundResults(ranking, groupStats,
                                   noisyRanking, noisyGroupStats);
    }

//     console.log(noisyGroups.length);
//     console.log('!!!!!');

    // Save the results for each player, and notify him.
    i = -1, len = noisyGroups.length;
    for (; ++i < len;) {
        j = -1, lenJ = noisyGroups[i].length;
        
//         console.log(noisyGroups[i].length);
//         console.log('======');
        
        for (; ++j < lenJ;) {
            contribObj = noisyGroups[i][j];

            // Position in Rank (array of group id, position within group).
            positionInNoisyRank = [i, j];
            pId = contribObj.player;
            
            playerPayoff = getPayoff(bars, positionInNoisyRank);
            
            // Updating the player database with the current payoff.
            code = channel.registry.getClient(pId);

            if (!code) {
                console.log('AAAH code not found: ', pId);                
            }      
            code.win = !code.win ? playerPayoff : code.win + playerPayoff;
            console.log('Added to ' + pId + ' ' + playerPayoff + ' ECU');
            // End Update.
            
            if (settings.DB === 'MONGODB') {
                node.game.savePlayerValues(contribObj, playerPayoff,
                                           positionInNoisyRank,
                                           ranking,
                                           noisyRanking,
                                           groupStats,
                                           currentStage);
            }

            emitPlayersResults(pId, bars, positionInNoisyRank,
                               playerPayoff, compatibility);
        }
    }
}


function sendResults() {
    var currentStage, previousStage,
    receivedData,
    sortedContribs,
    matching,
    ranking, groups, groupStats,
    noisyRanking, noisyGroups, noisyGroupStats,
    bars;

    currentStage = node.game.getCurrentGameStage();
    previousStage = node.game.plot.previous(currentStage);

    receivedData = node.game.memory.stage[previousStage]
        .selexec('key', '=', 'bid');
    
    // If a player submitted twice with reconnections.

    var i, len, o = {}, c, newSize = 0;
    i = -1, len = receivedData.db.length;
    for ( ; ++i < len ; ) {
        c = receivedData.db[i];
        if (!o[c.player]) {
            ++newSize;
        }
        o[c.player] = c;
    }
    if (newSize !== receivedData.length) {
        var newDb = [];
        for ( i in o ) {
            if (o.hasOwnProperty(i)) {
                newDb.push(o[i]);
            }
        }
        receivedData = new ngc.GameDB();
        receivedData.importDB(newDb);
    }

    // If a player submitted twice with reconnections.

    sortedContribs = receivedData
        .sort(sortContributions)
        .fetch();

    // Original Ranking (without noise).
    matching = doGroupMatching(sortedContribs);

    // Array of sorted player ids, from top to lowest contribution.
    ranking = matching.ranking;
    // Array of array of contributions objects.
    groups = matching.groups;
    // Compute average contrib and demand in each group.
    groupStats = computeGroupStats(groups);

    // Add Noise (not in this case).
    noisyRanking = ranking;
    noisyGroups = groups;
    noisyGroupStats = groupStats;

    // Bars for display in clients.
    bars = matching.bars;

    // Save to db, and sends results to players.
    finalizeRound(currentStage, bars,
                  groupStats, groups, ranking,
                  noisyGroupStats, noisyGroups, noisyRanking);
}
