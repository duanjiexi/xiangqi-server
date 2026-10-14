// server.js — 强化象棋联网服务器
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'users.json');

let users = {};
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { users = {}; }
function saveUsers(){ 
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); } catch(e){}
}

function hashPassword(password, salt){
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
}
function verifyPassword(password, storedHash, salt){
    return hashPassword(password, salt).hash === storedHash;
}

const online = new Map();
const idByWs = new WeakMap();
const rooms = new Map();
const playerRoom = new Map();
let matchQueue = [];

const wss = new WebSocket.Server({ port: PORT });
console.log(`🚀 服务器启动，端口 ${PORT}`);

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch(e){ return; }
        handle(ws, msg);
    });
    ws.on('close', () => {
        const id = idByWs.get(ws);
        if (id){
            online.delete(id);
            matchQueue = matchQueue.filter(x => x !== id);
            const rid = playerRoom.get(id);
            if (rid){
                const room = rooms.get(rid);
                if (room){
                    room.players.forEach(pid => {
                        if (pid !== id){ sendTo(pid, { type: 'opponentOffline' }); playerRoom.delete(pid); }
                    });
                }
                rooms.delete(rid); playerRoom.delete(id);
            }
            broadcastToFriends(id, { type: 'friendOffline', id });
        }
    });
});

function send(ws, data){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(data)); }
function sendTo(id, data){ const ws = online.get(id); if (ws) send(ws, data); }
function broadcastToFriends(id, data){
    const u = users[id]; if (!u) return;
    (u.friends || []).forEach(fid => sendTo(fid, data));
}
function changeStars(id, delta){
    if (!users[id]) return 0;
    let s = (users[id].stars || 0) + delta;
    if (s < 0) s = 0;
    users[id].stars = s;
    saveUsers();
    return s;
}

function handle(ws, msg){
    const t = msg.type;

    if (t === 'register'){
        const id = String(msg.id || '').trim();
        const password = String(msg.password || '');
        if (!/^\d{10}$/.test(id)) return send(ws, { type:'error', message:'ID 必须是 10 位数字' });
        if (password.length < 4) return send(ws, { type:'error', message:'密码至少 4 位' });

        if (users[id]){
            const ok = users[id].salt ? verifyPassword(password, users[id].passwordHash, users[id].salt) : false;
            if (!ok) return send(ws, { type:'error', message:'密码错误' });
            online.set(id, ws);
            idByWs.set(ws, id);
            send(ws, { type:'loginSuccess', id, friends: getFriendsWithStatus(id), stars: users[id].stars || 0 });
            broadcastToFriends(id, { type:'friendOnline', id });
        } else {
            const { hash, salt } = hashPassword(password);
            users[id] = { id, passwordHash: hash, salt, friends: [], stars: 0, wins: 0, loses: 0, createdAt: Date.now() };
            saveUsers();
            online.set(id, ws);
            idByWs.set(ws, id);
            send(ws, { type:'registerSuccess', id, friends: [], stars: 0 });
        }
        return;
    }

    const myId = idByWs.get(ws);
    if (!myId) return send(ws, { type:'error', message:'请先登录' });

    if (t === 'searchUser'){
        const tid = String(msg.targetId || '').trim();
        const u = users[tid];
        send(ws, {
            type:'searchResult', found: !!u,
            target: u ? { id: tid, online: online.has(tid), stars: u.stars || 0 } : null
        });
    }
    else if (t === 'addFriend'){
        const tid = msg.targetId;
        if (tid === myId) return send(ws, { type:'error', message:'不能添加自己' });
        if (!users[tid])  return send(ws, { type:'error', message:'用户不存在' });
        if (!users[myId].friends.includes(tid)) users[myId].friends.push(tid);
        if (!users[tid].friends.includes(myId)) users[tid].friends.push(myId);
        saveUsers();
        send(ws, { type:'friendAdded', friendId: tid });
        sendTo(tid, { type:'friendAdded', friendId: myId });
        send(ws, { type:'friendsList', friends: getFriendsWithStatus(myId) });
    }
    else if (t === 'getFriends'){
        send(ws, { type:'friendsList', friends: getFriendsWithStatus(myId) });
    }
    else if (t === 'invite'){
        const fid = msg.friendId;
        if (!online.has(fid)) return send(ws, { type:'error', message:'对方不在线' });
        if (!users[myId].friends.includes(fid)) return send(ws, { type:'error', message:'对方不是你的好友' });
        const roomId = 'F' + myId + '_' + fid + '_' + Date.now();
        sendTo(fid, { type:'invited', from: myId, roomId });
        send(ws, { type:'inviteSent', to: fid });
    }
    else if (t === 'acceptInvite'){
        const fromId = msg.fromId;
        const roomId = msg.roomId;
        rooms.set(roomId, { players: [myId, fromId], isMatch: false });
        playerRoom.set(myId, roomId);
        playerRoom.set(fromId, roomId);
        sendTo(fromId, { type:'roomStart', roomId, opponent: myId,
            opponentStars: users[myId]?.stars || 0, mySide:'red',   isMatch: false });
        send(ws,       { type:'roomStart', roomId, opponent: fromId,
            opponentStars: users[fromId]?.stars || 0, mySide:'black', isMatch: false });
    }
    else if (t === 'declineInvite'){
        sendTo(msg.fromId, { type:'inviteDeclined', by: myId });
    }
    else if (t === 'startMatch'){
        if (matchQueue.includes(myId)) return;
        if (playerRoom.has(myId)) return send(ws, { type:'error', message:'正在对局中' });
        matchQueue.push(myId);
        send(ws, { type:'matching', position: matchQueue.length });
        tryMatch();
    }
    else if (t === 'cancelMatch'){
        matchQueue = matchQueue.filter(x => x !== myId);
        send(ws, { type:'matchCancelled' });
    }
    else if (t === 'move'){
        sendTo(msg.opponentId, { type:'move', sx: msg.sx, sy: msg.sy, tx: msg.tx, ty: msg.ty });
    }
    else if (t === 'gameEnd'){
        const winnerId = msg.winnerId;
        const loserId  = msg.loserId;
        const rid = playerRoom.get(winnerId);
        const room = rid ? rooms.get(rid) : null;
        const isMatch = room && room.isMatch;

        if (isMatch){
            const nw = changeStars(winnerId, +1);
            const nl = changeStars(loserId,  -1);
            users[winnerId].wins  = (users[winnerId].wins||0) + 1;
            if (users[loserId]) users[loserId].loses = (users[loserId].loses||0) + 1;
            saveUsers();
            sendTo(winnerId, { type:'starsUpdated', stars: nw, delta: +1, win: true,  mat
