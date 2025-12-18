const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../client/dist')));

// --- Game State ---
const rooms = {}; // roomId -> Room Object

function createRoom(hostId) {
    const roomId = 'room-' + Math.floor(1000 + Math.random() * 9000); // Simple 4 digit code
    const newRoom = {
        id: roomId,
        hostId: hostId,
        players: {}, // socketId -> { id, name, role, isAlive, avatar, isOnline }
        phase: 'LOBBY', // LOBBY, NIGHT_INTRO, NIGHT_MAFIA, NIGHT_NURSE, NIGHT_DETECTIVE, NIGHT_RESULT, DAY_DISCUSSION
        nightActions: {
            mafiaTarget: null,
            nurseTarget: null,
            detectiveTarget: null,
            nurseSelfHealUsed: false, // Track if Nurse used self-heal
        },
        roundCount: 1,
        winner: null,
    };
    rooms[roomId] = newRoom;
    return newRoom;
}

// --- Logic Helper ---

function assignRoles(room) {
    const playerIds = Object.keys(room.players);
    const playerCount = playerIds.length;

    let mafiaCount = 1;
    if (playerCount >= 9) {
        mafiaCount = 2;
    }

    // Shuffle
    const shuffled = playerIds.sort(() => 0.5 - Math.random());

    // Assign Roles
    // 1. Mafia
    for (let i = 0; i < mafiaCount; i++) {
        room.players[shuffled[i]].role = 'MAFIA';
    }
    // 2. Detective (Old Man) - Always 1
    room.players[shuffled[mafiaCount]].role = 'DETECTIVE';

    // 3. Nurse - Always 1
    room.players[shuffled[mafiaCount + 1]].role = 'NURSE';

    // 4. Citizens - The Rest
    for (let i = mafiaCount + 2; i < playerCount; i++) {
        room.players[shuffled[i]].role = 'CITIZEN';
    }
}

function checkWinCondition(room) {
    const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
    const mafiaCount = alivePlayers.filter(p => p.role === 'MAFIA').length;
    const citizenCount = alivePlayers.length - mafiaCount;

    if (mafiaCount === 0) {
        room.winner = 'CITIZENS';
        return true;
    }
    if (mafiaCount >= citizenCount) {
        // "If 4 remaining and 2 are mafia (2v2) -> Mafia wins"
        // "If 1 mafia and 1 citizen remaining -> Mafia wins"
        room.winner = 'MAFIA';
        return true;
    }
    return false;
}

// --- Socket Handlers ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Host Create Game
    socket.on('create_room', (data) => {
        const room = createRoom(socket.id);
        socket.join(room.id);
        socket.emit('room_created', { roomId: room.id });
        console.log(`Room ${room.id} created by ${socket.id}`);
    });

    // Player Join Game
    socket.on('join_room', ({ roomId, name }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }
        if (room.phase !== 'LOBBY') {
            socket.emit('error', 'Game already started');
            return;
        }

        const player = {
            id: socket.id,
            name: name,
            role: null, // Assigned later
            isAlive: true,
            isOnline: true,
        };

        room.players[socket.id] = player;
        socket.join(roomId);

        // Notify everyone in room
        io.to(roomId).emit('player_joined', Object.values(room.players));
        console.log(`${name} joined ${roomId}`);
    });

    // Host Start Game
    socket.on('start_game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        // Logic: Role Assignment
        assignRoles(room);

        room.phase = 'NIGHT_INTRO'; // Audio: "Everyone Sleep"
        room.roundCount = 1;

        io.to(roomId).emit('game_started', {
            players: room.players,
            hostId: room.hostId
        });

        // Send roles to each player individually
        Object.values(room.players).forEach(p => {
            io.to(p.id).emit('role_assigned', { role: p.role });
        });

        io.to(roomId).emit('phase_change', { phase: 'NIGHT_INTRO' });

        console.log(`Game started in ${roomId}`);
    });

    // --- Phase Transitions (Triggered by Client Audio completion or Timer) ---
    // The Host device will likely drive the audio state. When Host Audio Finishes, it tells server to move on.

    socket.on('next_phase', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        // State Machine
        switch (room.phase) {
            case 'NIGHT_INTRO':
                room.phase = 'NIGHT_MAFIA';
                io.to(roomId).emit('phase_change', { phase: 'NIGHT_MAFIA' });
                break;
            case 'NIGHT_MAFIA':
                // Handled after Mafia action usually, but if timer runs out?
                // Wait for action.
                break;
            case 'NIGHT_NURSE':
                // Wait for action
                break;
            case 'NIGHT_DETECTIVE':
                // Wait for action
                break;
            case 'NIGHT_RESULT':
                room.phase = 'DAY_DISCUSSION';
                io.to(roomId).emit('phase_change', { phase: 'DAY_DISCUSSION', timer: 105 }); // 1:45
                break;
            case 'DAY_DISCUSSION':
                // Loop back or End?
                // Usually goes to Night Intro again unless game over
                room.roundCount++;
                // Clean up night actions
                room.nightActions = {
                    mafiaTarget: null,
                    nurseTarget: null,
                    detectiveTarget: null,
                    nurseSelfHealUsed: room.nightActions.nurseSelfHealUsed
                };

                room.phase = 'NIGHT_INTRO';
                io.to(roomId).emit('phase_change', { phase: 'NIGHT_INTRO' });
                break;
        }
    });

    // --- Night Actions ---

    // Mafia Action
    socket.on('mafia_vote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;

        // If 2 mafia, first one locks it in (as per requirement: "if two mafia, answer of first one")
        if (room.phase === 'NIGHT_MAFIA' && !room.nightActions.mafiaTarget) {
            room.nightActions.mafiaTarget = targetId;
            // 3 seconds delay handled by Client? Or Server?
            // "After 3 seconds... Nurse open eyes"
            // Server should acknowledge receipt, then Host Client plays audio, then requests next phase.
            io.to(roomId).emit('mafia_action_confirmed');

            // Auto transition logic could be here, or Host driven. 
            // Request says: "After 3 seconds... audio plays".
            // Let's have server move state immediately or after short delay, but let Host client manage Audio playback timing.
            setTimeout(() => {
                room.phase = 'NIGHT_NURSE';
                io.to(roomId).emit('phase_change', { phase: 'NIGHT_NURSE' });
            }, 3000);
        }
    });

    // Nurse Action
    socket.on('nurse_action', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[socket.id]; // The nurse
        if (!player || player.role !== 'NURSE') return;

        if (room.phase === 'NIGHT_NURSE') {
            // Check self heal logic
            if (targetId === socket.id) {
                if (room.nightActions.nurseSelfHealUsed) {
                    socket.emit('error', 'Cannot heal self twice');
                    return;
                }
                room.nightActions.nurseSelfHealUsed = true;
            }

            room.nightActions.nurseTarget = targetId;
            io.to(roomId).emit('nurse_action_confirmed');

            setTimeout(() => {
                room.phase = 'NIGHT_DETECTIVE';
                io.to(roomId).emit('phase_change', { phase: 'NIGHT_DETECTIVE' });
            }, 3000);
        }
    });

    // Detective Action
    socket.on('detective_action', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.phase === 'NIGHT_DETECTIVE') {
            const targetPlayer = room.players[targetId];
            if (targetPlayer) {
                // Reveal role to Detective ONLY
                socket.emit('detective_result', {
                    targetName: targetPlayer.name,
                    targetRole: targetPlayer.role
                });
            }

            // Proceed to Result Phase
            room.nightActions.detectiveTarget = targetId; // Just for logging

            setTimeout(() => {
                // Calculate Night Result
                let victimId = room.nightActions.mafiaTarget;
                let saved = false;

                if (victimId) {
                    if (victimId === room.nightActions.nurseTarget) {
                        saved = true;
                    } else {
                        room.players[victimId].isAlive = false;
                    }
                }

                room.phase = 'NIGHT_RESULT';
                io.to(roomId).emit('phase_change', {
                    phase: 'NIGHT_RESULT',
                    result: {
                        victimId: saved ? null : victimId,
                        saved: saved
                    }
                });

                // Check Win Condition Immediately
                if (checkWinCondition(room)) {
                    io.to(roomId).emit('game_over', { winner: room.winner });
                }

            }, 3000);
        }
    });

    // --- Day Actions ---

    socket.on('host_kill', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        const target = room.players[targetId];
        if (target) {
            target.isAlive = false;
            io.to(roomId).emit('player_killed', { playerId: targetId });

            if (checkWinCondition(room)) {
                io.to(roomId).emit('game_over', { winner: room.winner });
            } else {
                // Start Next Round
                // room.phase = 'NIGHT_INTRO';
                // io.to(roomId).emit('phase_change', {phase: 'NIGHT_INTRO'});
                // Actually host needs to press "Start Round" manually? 
                // Request: "After host chooses... start next round"
                // So we can auto transition here or wait for button.
                // Let's auto transition as per "After host chooses... start next round"

                room.roundCount++;
                room.nightActions = {
                    mafiaTarget: null,
                    nurseTarget: null,
                    detectiveTarget: null,
                    nurseSelfHealUsed: room.nightActions.nurseSelfHealUsed
                };
                room.phase = 'NIGHT_INTRO';
                io.to(roomId).emit('phase_change', { phase: 'NIGHT_INTRO' });
            }
        }
    });

    socket.on('host_skip', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        // Skip vote, go to next night
        room.roundCount++;
        room.nightActions = {
            mafiaTarget: null,
            nurseTarget: null,
            detectiveTarget: null,
            nurseSelfHealUsed: room.nightActions.nurseSelfHealUsed
        };
        room.phase = 'NIGHT_INTRO';
        io.to(roomId).emit('phase_change', { phase: 'NIGHT_INTRO' });
    });


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Handle reconnection logic in real app, simply remove for now or mark offline
    });
});

// All other GET requests not handled before will return the React app
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
