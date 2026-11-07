const WEEK = 7 * 24 * 60 * 60 * 1000;
const TURN_MS = 60 * 1000;
const SECTORS = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];
let schemaPromise;

function weekStart(timestamp) {
  const local = new Date(timestamp + 10800000);
  local.setUTCDate(local.getUTCDate() - local.getUTCDay());
  local.setUTCHours(9, 0, 0, 0);
  let start = local.getTime() - 10800000;
  if (timestamp < start) start -= WEEK;
  return new Date(start).toISOString();
}

async function ensureTables(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await Promise.all([
        db.prepare("CREATE TABLE IF NOT EXISTS nyg_darts_presence (member_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, last_seen INTEGER NOT NULL)").run(),
        db.prepare("CREATE TABLE IF NOT EXISTS nyg_darts_queue (member_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, queued_at INTEGER NOT NULL)").run(),
        db.prepare("CREATE TABLE IF NOT EXISTS nyg_darts_matches (id TEXT PRIMARY KEY, player1_id TEXT NOT NULL, player2_id TEXT NOT NULL, player1_name TEXT NOT NULL, player2_name TEXT NOT NULL, opponent_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', turn_player_id TEXT NOT NULL, round_no INTEGER NOT NULL DEFAULT 1, round_deadline INTEGER NOT NULL DEFAULT 0, player1_visit INTEGER NOT NULL DEFAULT 0, player2_visit INTEGER NOT NULL DEFAULT 0, player1_points INTEGER NOT NULL DEFAULT 0, player2_points INTEGER NOT NULL DEFAULT 0, player1_throws TEXT NOT NULL DEFAULT '[]', player2_throws TEXT NOT NULL DEFAULT '[]', winner_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run(),
        db.prepare("CREATE TABLE IF NOT EXISTS nyg_darts_scores (id TEXT PRIMARY KEY, match_id TEXT NOT NULL, member_id TEXT NOT NULL, week_start TEXT NOT NULL, points INTEGER NOT NULL, opponent_type TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(member_id, match_id))").run()
      ]);

      const columns = await db.prepare("PRAGMA table_info(nyg_darts_matches)").all();

      if (!(columns.results || []).some(column => column.name === "round_deadline")) {
        await db.prepare(
          "ALTER TABLE nyg_darts_matches ADD COLUMN round_deadline INTEGER NOT NULL DEFAULT 0"
        ).run();
      }

      await db.prepare(
        "UPDATE nyg_darts_matches SET round_deadline=updated_at+? WHERE status='open' AND round_deadline=0"
      ).bind(TURN_MS).run();
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }

  return schemaPromise;
}

function scoreThrow(x, y) {
  const radius = Math.hypot(x, y);

  if (radius > 1) return { points: 0, label: "MISS" };
  if (radius <= 0.052) return { points: 50, label: "BULL 50" };
  if (radius <= 0.105) return { points: 25, label: "BULL 25" };

  const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
  const base = SECTORS[Math.round(angle / (Math.PI * 2 / 20)) % 20];
  const multiplier =
    radius >= 0.54 && radius <= 0.63 ? 3 :
    radius >= 0.91 && radius <= 0.98 ? 2 : 1;

  return {
    points: base * multiplier,
    label: (multiplier === 3 ? "T" : multiplier === 2 ? "D" : "") + base
  };
}

function matchView(row, memberId) {
  const youArePlayer1 = row.player1_id === memberId;

  return {
    id: row.id,
    status: row.status,
    opponent_type: row.opponent_type,
    round: Number(row.round_no),
    rounds_total: null,
    time_left: Math.max(
      0,
      Math.ceil((Number(row.round_deadline || 0) - Date.now()) / 1000)
    ),
    your_turn: row.status === "open" && row.turn_player_id === memberId,
    you_are_player1: youArePlayer1,
    winner_is_you: row.winner_id === memberId,
    tie: row.status === "complete" && !row.winner_id,
    player1: {
      name: row.player1_name,
      points: Number(row.player1_points),
      visit: Number(row.player1_visit),
      throws: JSON.parse(row.player1_throws || "[]")
    },
    player2: {
      name: row.player2_name,
      points: Number(row.player2_points),
      visit: Number(row.player2_visit),
      throws: JSON.parse(row.player2_throws || "[]")
    }
  };
}

async function getMemberMatch(db, id, memberId) {
  return db.prepare(
    "SELECT * FROM nyg_darts_matches WHERE id=? AND (player1_id=? OR player2_id=?)"
  ).bind(id, memberId, memberId).first();
}

async function createMatch(db, p1, p2, type) {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db.prepare(
    "INSERT INTO nyg_darts_matches (id,player1_id,player2_id,player1_name,player2_name,opponent_type,status,turn_player_id,round_no,round_deadline,created_at,updated_at) VALUES (?,?,?,?,?,?,'open',?,1,?,?,?)"
  ).bind(
    id,
    p1.id,
    p2.id,
    p1.name,
    p2.name,
    type,
    p1.id,
    now + TURN_MS,
    now,
    now
  ).run();

  return db.prepare(
    "SELECT * FROM nyg_darts_matches WHERE id=?"
  ).bind(id).first();
}

async function activeState(db, member) {
  const match = await db.prepare(
    "SELECT * FROM nyg_darts_matches WHERE status='open' AND (player1_id=? OR player2_id=?) ORDER BY created_at DESC LIMIT 1"
  ).bind(member.id, member.id).first();

  if (match) {
    const updated = await updateMatchClock(db, match);
    return { status: "match", match: matchView(updated, member.id) };
  }

  const queued = await db.prepare(
    "SELECT queued_at FROM nyg_darts_queue WHERE member_id=?"
  ).bind(member.id).first();

  if (queued) {
    const now = Date.now();

    await db.prepare(
      "UPDATE nyg_darts_queue SET queued_at=? WHERE member_id=?"
    ).bind(now, member.id).run();

    return { status: "waiting", queued_at: now };
  }

  return { status: "idle" };
}

async function findMatch(db, member) {
  const active = await db.prepare(
    "SELECT * FROM nyg_darts_matches WHERE status='open' AND (player1_id=? OR player2_id=?) ORDER BY created_at DESC LIMIT 1"
  ).bind(member.id, member.id).first();

  if (active) {
    const updated = await updateMatchClock(db, active);
    return { status: "match", match: matchView(updated, member.id) };
  }

  const now = Date.now();

  await db.prepare(
    "DELETE FROM nyg_darts_queue WHERE queued_at<?"
  ).bind(now - 60000).run();

  const waiting = await db.prepare(
    "SELECT member_id,full_name FROM nyg_darts_queue WHERE member_id<>? ORDER BY queued_at ASC LIMIT 1"
  ).bind(member.id).first();

  if (waiting) {
    const first = await db.prepare(
      "SELECT id,full_name FROM members WHERE id=? AND status='active'"
    ).bind(waiting.member_id).first();

    if (first) {
      const row = await createMatch(
        db,
        { id: first.id, name: first.full_name || waiting.full_name },
        { id: member.id, name: member.full_name || "Mwanachama" },
        "online"
      );

      await db.batch([
        db.prepare(
          "DELETE FROM nyg_darts_queue WHERE member_id=?"
        ).bind(first.id),
        db.prepare(
          "DELETE FROM nyg_darts_queue WHERE member_id=?"
        ).bind(member.id)
      ]);

      return { status: "match", match: matchView(row, member.id) };
    }

    await db.prepare(
      "DELETE FROM nyg_darts_queue WHERE member_id=?"
    ).bind(waiting.member_id).run();
  }

  await db.prepare(
    "INSERT INTO nyg_darts_queue (member_id,full_name,queued_at) VALUES (?,?,?) ON CONFLICT(member_id) DO UPDATE SET full_name=excluded.full_name,queued_at=excluded.queued_at"
  ).bind(member.id, member.full_name || "Mwanachama", now).run();

  return { status: "waiting", queued_at: now };
}

function computerThrow() {
  const angle = (Math.random() - 0.5) * 0.48;
  const radius = Math.max(0.08, Math.min(1.08, 0.52 + (Math.random() - 0.5) * 0.72));

  return {
    x: Math.sin(angle) * radius,
    y: -Math.cos(angle) * radius
  };
}

async function updateMatchClock(db, initialRow) {
  let row = initialRow;
  let now = Date.now();

  if (row.status !== "open") return row;

  if (Number(row.round_deadline || 0) <= now) {
    let turn = row.turn_player_id;
    let round = Number(row.round_no);

    if (turn === row.player1_id) {
      turn = row.player2_id;
    } else {
      round += 1;
      turn = row.player1_id;
    }

    await db.prepare(
      "UPDATE nyg_darts_matches SET turn_player_id=?,round_no=?,round_deadline=?,player1_visit=0,player2_visit=0,updated_at=? WHERE id=? AND status='open' AND round_deadline=?"
    ).bind(
      turn,
      round,
      now + TURN_MS,
      now,
      row.id,
      row.round_deadline
    ).run();

    row = await db.prepare(
      "SELECT * FROM nyg_darts_matches WHERE id=?"
    ).bind(row.id).first();

    now = Date.now();
  }

  if (
    row.status === "open" &&
    row.opponent_type === "computer" &&
    row.turn_player_id === row.player2_id &&
    now - Number(row.updated_at || 0) >= 1900
  ) {
    const point = computerThrow();
    const dart = {
      id: crypto.randomUUID(),
      created_at: now,
      ...point,
      ...scoreThrow(point.x, point.y)
    };

    const throws = JSON.parse(row.player2_throws || "[]");
    throws.push(dart);

    // Huzuia maombi mawili ya wakati mmoja kuongeza dart ileile ya kompyuta.
    await db.prepare(
      "UPDATE nyg_darts_matches SET player2_points=player2_points+?,player2_throws=?,updated_at=? WHERE id=? AND status='open' AND turn_player_id=? AND updated_at=?"
    ).bind(
      dart.points,
      JSON.stringify(throws),
      now,
      row.id,
      row.player2_id,
      row.updated_at
    ).run();

    row = await db.prepare(
      "SELECT * FROM nyg_darts_matches WHERE id=?"
    ).bind(row.id).first();
  }

  return row;
}


const DARTS_PRIZES = {
  1: 3000,
  2: 2000,
  3: 1000
};

const DARTS_MIN_DAYS = 3;

async function leaderboard(db, start) {
  const result = await db.prepare(`
    SELECT
      s.member_id,
      COALESCE(m.full_name, 'Mwanachama') AS full_name,
      SUM(s.points) AS points,
      COUNT(*) AS matches_played,
      MAX(s.points) AS best_match,
      COUNT(DISTINCT DATE(
        s.created_at,
        '+3 hours'
      )) AS days_played
    FROM nyg_darts_scores s
    LEFT JOIN members m
      ON m.id = s.member_id
    WHERE s.week_start = ?
  AND s.opponent_type = 'computer'
    GROUP BY s.member_id, m.full_name
    ORDER BY
      points DESC,
      matches_played DESC,
      full_name COLLATE NOCASE ASC,
      s.member_id ASC
    LIMIT 5
  `).bind(start).all();

  return (result.results || []).map((row, index) => {
    const rank = index + 1;
    const daysPlayed = Number(row.days_played || 0);
    const prizeAmount = DARTS_PRIZES[rank] || 0;

    const eligible =
      rank <= 3 &&
      daysPlayed >= DARTS_MIN_DAYS;

    return {
      rank,    
member_id: row.member_id,
      full_name: row.full_name,
      points: Number(row.points || 0),
      matches_played: Number(row.matches_played || 0),
      best_match: Number(row.best_match || 0),

      days_played: daysPlayed,
      required_days: DARTS_MIN_DAYS,

      prize_amount: prizeAmount,
      prize_type: prizeAmount > 0
        ? "DATA BUNDLE"
        : null,

      prize_eligible: eligible,

      prize_status: rank > 3
        ? "NO_PRIZE"
        : eligible
          ? "ELIGIBLE"
          : "NOT_ELIGIBLE",

      prize_message: rank > 3
        ? "Hongera kwa kushiriki NYG DARTS."
        : eligible
          ? "Hongera! Umekidhi masharti ya zawadi."
          : "Hongera kwa nafasi yako! Hujakidhi sharti la kucheza angalau siku 3 tofauti. Huna haki ya kudai zawadi wiki hii."
    };
  });
}


async function finishMatch(db, row, p1, p2, t1, t2, now) {
  const winner = p1 === p2 ? null : (p1 > p2 ? row.player1_id : row.player2_id);
  const week = weekStart(now);
  const finished = new Date(now).toISOString();

  const statements = [
    db.prepare(
      "UPDATE nyg_darts_matches SET status='complete',round_deadline=0,player1_points=?,player2_points=?,player1_throws=?,player2_throws=?,player1_visit=0,player2_visit=0,winner_id=?,updated_at=? WHERE id=? AND status='open'"
    ).bind(
      p1,
      p2,
      JSON.stringify(t1),
      JSON.stringify(t2),
      winner,
      now,
      row.id
    ),
    db.prepare(
      "INSERT OR IGNORE INTO nyg_darts_scores (id,match_id,member_id,week_start,points,opponent_type,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(
      crypto.randomUUID(),
      row.id,
      row.player1_id,
      week,
      p1,
      row.opponent_type,
      finished
    )
  ];

  if (row.opponent_type === "online") {
    statements.push(
      db.prepare(
        "INSERT OR IGNORE INTO nyg_darts_scores (id,match_id,member_id,week_start,points,opponent_type,created_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(
        crypto.randomUUID(),
        row.id,
        row.player2_id,
        week,
        p2,
        row.opponent_type,
        finished
      )
    );
  }

  await db.batch(statements);

  return db.prepare(
    "SELECT * FROM nyg_darts_matches WHERE id=?"
  ).bind(row.id).first();
}

export async function handleDartsApi(request, env, url, path, method, tools) {
  if (!path.startsWith("/api/darts/")) return null;

  if (!env.MEMBERS_DB) {
    return tools.reply({ error: "Mfumo wa NYG Darts haujaunganishwa." }, 503);
  }

  const db = env.MEMBERS_DB;

  try {
    await ensureTables(db);
  } catch {
    return tools.reply({ error: "Hifadhi ya NYG Darts haijaandaliwa." }, 503);
  }

  if (path === "/api/darts/leaderboard" && method === "GET") {
    try {
      const now = Date.now();
      const current = weekStart(now);
      const previous = new Date(Date.parse(current) - WEEK).toISOString();

      return tools.reply({
        week_start: current,
        next_reset_at: new Date(Date.parse(current) + WEEK).toISOString(),
        leaderboard: await leaderboard(db, current),
        previous_week: {
          week_start: previous,
          winners: await leaderboard(db, previous)
        }
      });
    } catch {
      return tools.reply({ error: "Imeshindikana kupata ubao wa NYG Darts." }, 500);
    }
  }

  const member = await tools.getMember(request, env);

  if (!member) {
    return tools.reply({ error: "Ingia au jisajili ili kushiriki NYG Darts." }, 401);
  }

  if (method === "POST" && !tools.sameOrigin(request, url)) {
    return tools.reply({ error: "Ombi halijaruhusiwa." }, 403);
  }

  if (path === "/api/darts/presence" && method === "POST") {
    const now = Date.now();

    await db.prepare(
      "INSERT INTO nyg_darts_presence (member_id,full_name,last_seen) VALUES (?,?,?) ON CONFLICT(member_id) DO UPDATE SET full_name=excluded.full_name,last_seen=excluded.last_seen"
    ).bind(member.id, member.full_name || "Mwanachama", now).run();

    const count = await db.prepare(
      "SELECT COUNT(*) AS total FROM nyg_darts_presence WHERE last_seen>?"
    ).bind(now - 60000).first();

    return tools.reply({ online: Number(count?.total || 1) });
  }

  if (path === "/api/darts/active" && method === "GET") {
    try {
      return tools.reply(await activeState(db, member));
    } catch {
      return tools.reply({ error: "Imeshindikana kupata hali ya mechi." }, 500);
    }
  }

  if (path === "/api/darts/matchmaking" && method === "POST") {
    try {
      return tools.reply(await findMatch(db, member));
    } catch {
      return tools.reply({ error: "Imeshindikana kutafuta mpinzani. Jaribu tena." }, 500);
    }
  }

  if (path === "/api/darts/computer" && method === "POST") {
    try {
      const active = await db.prepare(
        "SELECT * FROM nyg_darts_matches WHERE status='open' AND (player1_id=? OR player2_id=?) ORDER BY created_at DESC LIMIT 1"
      ).bind(member.id, member.id).first();

      if (active) {
        const updated = await updateMatchClock(db, active);
        return tools.reply({ status: "match", match: matchView(updated, member.id) });
      }

      const row = await createMatch(
        db,
        { id: member.id, name: member.full_name || "Mwanachama" },
        { id: "computer-" + crypto.randomUUID(), name: "Kompyuta" },
        "computer"
      );

      await db.prepare(
        "DELETE FROM nyg_darts_queue WHERE member_id=?"
      ).bind(member.id).run();

      return tools.reply({ status: "match", match: matchView(row, member.id) });
    } catch {
      return tools.reply({ error: "Imeshindikana kuanzisha mechi ya kompyuta." }, 500);
    }
  }

  if (path === "/api/darts/match" && method === "GET") {
    const id = url.searchParams.get("id") || "";
    const row = await getMemberMatch(db, id, member.id);

    if (!row) {
      return tools.reply({ error: "Mechi haijapatikana." }, 404);
    }

    const updated = await updateMatchClock(db, row);
    return tools.reply({ match: matchView(updated, member.id) });
  }

  if (path === "/api/darts/finish" && method === "POST") {
    const data = await request.json().catch(() => null);
    const id = typeof data?.match_id === "string" ? data.match_id : "";

    try {
      const row = await getMemberMatch(db, id, member.id);

      if (!row) {
        return tools.reply({ error: "Mechi haijapatikana." }, 404);
      }

      if (row.status === "complete") {
        return tools.reply({ match: matchView(row, member.id) });
      }

      const current = await updateMatchClock(db, row);

      if (current.status === "complete") {
        return tools.reply({ match: matchView(current, member.id) });
      }

      const finished = await finishMatch(
        db,
        current,
        Number(current.player1_points),
        Number(current.player2_points),
        JSON.parse(current.player1_throws || "[]"),
        JSON.parse(current.player2_throws || "[]"),
        Date.now()
      );

      return tools.reply({ match: matchView(finished, member.id) });
    } catch {
      return tools.reply({ error: "Imeshindikana kumaliza mechi na kuhifadhi alama." }, 500);
    }
  }

  if (path === "/api/darts/throw" && method === "POST") {
    const data = await request.json().catch(() => null);
    const id = typeof data?.match_id === "string" ? data.match_id : "";
    const x = Number(data?.x);
    const y = Number(data?.y);

    if (
      !id ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 1.5 ||
      Math.abs(y) > 1.5
    ) {
      return tools.reply({ error: "Lengo la mshale halijakubaliwa." }, 400);
    }

    try {
      const row = await getMemberMatch(db, id, member.id);

      if (!row || row.status !== "open") {
        return tools.reply({ error: "Mechi hii imekwisha au haipo." }, 409);
      }

      const current = await updateMatchClock(db, row);

      if (current.status !== "open") {
        return tools.reply({ error: "Muda wa mechi umeisha." }, 409);
      }

      if (current.turn_player_id !== member.id) {
        return tools.reply({ error: "Zamu yako imeisha au subiri zamu yako." }, 409);
      }

      const now = Date.now();
      const dart = {
        id: crypto.randomUUID(),
        created_at: now,
        x,
        y,
        ...scoreThrow(x, y)
      };

      let savedThrow;

      if (member.id === current.player1_id) {
        const throws = JSON.parse(current.player1_throws || "[]");
        throws.push(dart);

        savedThrow = await db.prepare(
          "UPDATE nyg_darts_matches SET player1_points=player1_points+?,player1_throws=?,updated_at=? WHERE id=? AND status='open' AND turn_player_id=? AND round_deadline>? AND updated_at=?"
        ).bind(
          dart.points,
          JSON.stringify(throws),
          now,
          current.id,
          member.id,
          now,
          current.updated_at
        ).run();
      } else {
        const throws = JSON.parse(current.player2_throws || "[]");
        throws.push(dart);

        savedThrow = await db.prepare(
          "UPDATE nyg_darts_matches SET player2_points=player2_points+?,player2_throws=?,updated_at=? WHERE id=? AND status='open' AND turn_player_id=? AND round_deadline>? AND updated_at=?"
        ).bind(
          dart.points,
          JSON.stringify(throws),
          now,
          current.id,
          member.id,
          now,
          current.updated_at
        ).run();
      }

      if (Number(savedThrow.meta?.changes || 0) !== 1) {
        return tools.reply({
          error: "Dart nyingine imehifadhiwa kwa wakati mmoja. Jaribu tena."
        }, 409);
      }

      const saved = await db.prepare(
        "SELECT * FROM nyg_darts_matches WHERE id=?"
      ).bind(current.id).first();

      return tools.reply({
        dart,
        match: matchView(saved, member.id)
      });
    } catch {
      return tools.reply({ error: "Mshale haukuweza kuhifadhiwa. Jaribu tena." }, 500);
    }
  }

  return tools.reply({ error: "Njia ya NYG Darts haipatikani." }, 404);
}
