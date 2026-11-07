
const WEEK = 7 * 86400000;
const TURN_MS = 60000;
const INVITE_MS = 120000;
const ONLINE_MS = 60000;
const SECTORS = [
  20,1,18,4,13,6,10,15,2,17,
  3,19,7,16,8,11,14,9,12,5
];

const json = (value, fallback=[]) => {
  try {
    const result=JSON.parse(value);
    return Array.isArray(result)?result:fallback;
  } catch {
    return fallback;
  }
};

function weekStart(time) {
  const local=new Date(time+10800000);
  local.setUTCDate(local.getUTCDate()-local.getUTCDay());
  local.setUTCHours(9,0,0,0);
  let start=local.getTime()-10800000;
  if(time<start)start-=WEEK;
  return new Date(start).toISOString();
}

async function ensureTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_presence (
      member_id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_queue (
      member_id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_matches (
      id TEXT PRIMARY KEY,
      player1_id TEXT NOT NULL,
      player2_id TEXT NOT NULL,
      player1_name TEXT NOT NULL,
      player2_name TEXT NOT NULL,
      opponent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      turn_player_id TEXT NOT NULL,
      round_no INTEGER NOT NULL DEFAULT 1,
      round_deadline INTEGER NOT NULL DEFAULT 0,
      player1_visit INTEGER NOT NULL DEFAULT 0,
      player2_visit INTEGER NOT NULL DEFAULT 0,
      player1_points INTEGER NOT NULL DEFAULT 0,
      player2_points INTEGER NOT NULL DEFAULT 0,
      player1_throws TEXT NOT NULL DEFAULT '[]',
      player2_throws TEXT NOT NULL DEFAULT '[]',
      winner_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rounds_total INTEGER NOT NULL DEFAULT 3
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_scores (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      points INTEGER NOT NULL,
      opponent_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(member_id,match_id)
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_invites (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      match_id TEXT
    )
    
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nyg_darts_player_locks (
      member_id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();

  `).run();

  const columns=await db.prepare(
    "PRAGMA table_info(nyg_darts_matches)"
  ).all();

  const names=new Set(
    (columns.results||[]).map(c=>c.name)
  );

  if(!names.has("rounds_total")) {
    await db.prepare(`
      ALTER TABLE nyg_darts_matches
      ADD COLUMN rounds_total INTEGER NOT NULL DEFAULT 3
    `).run();
  }

  if(!names.has("round_deadline")) {
    await db.prepare(`
      ALTER TABLE nyg_darts_matches
      ADD COLUMN round_deadline INTEGER NOT NULL DEFAULT 0
    `).run();
  }

  await db.prepare(`
    UPDATE nyg_darts_matches
    SET round_deadline=updated_at+?
    WHERE status='open' AND round_deadline=0
  `).bind(TURN_MS).run();
}

function scoreThrow(x,y) {
  const r=Math.hypot(x,y);

  if(r>1)return {points:0,label:"MISS"};
  if(r<=.052)return {points:50,label:"BULL 50"};
  if(r<=.105)return {points:25,label:"BULL 25"};

  const angle=(Math.atan2(x,-y)+Math.PI*2)%(Math.PI*2);
  const number=SECTORS[
    Math.round(angle/(Math.PI*2/20))%20
  ];

  const multiplier=
    r>=.54&&r<=.63?3:
    r>=.91&&r<=.98?2:1;

  return {
    points:number*multiplier,
    label:(multiplier===3?"T":multiplier===2?"D":"")+number
  };
}

function matchView(row,memberId) {
  const p1=row.player1_id===memberId;
  const complete=row.status==="complete";

  return {
    id:row.id,
    status:row.status,
    opponent_type:row.opponent_type,
    round:Number(row.round_no),
    rounds_total:Number(row.rounds_total||3),
    time_left:complete?0:Math.max(
      0,Math.ceil((Number(row.round_deadline)-Date.now())/1000)
    ),
    your_turn:!complete&&row.turn_player_id===memberId,
    you_are_player1:p1,
    winner_is_you:complete&&row.winner_id===memberId,
    tie:complete&&!row.winner_id,
    winner_id:row.winner_id,
    player1:{
      name:row.player1_name,
      points:Number(row.player1_points),
      visit:Number(row.player1_visit||0),
      throws:json(row.player1_throws)
    },
    player2:{
      name:row.player2_name,
      points:Number(row.player2_points),
      visit:Number(row.player2_visit||0),
      throws:json(row.player2_throws)
    }
  };
}

async function getMatch(db,id) {
  return db.prepare(`
    SELECT * FROM nyg_darts_matches WHERE id=?
  `).bind(id).first();
}

async function memberMatch(db,id,memberId) {
  return db.prepare(`
    SELECT * FROM nyg_darts_matches
    WHERE id=? AND (player1_id=? OR player2_id=?)
  `).bind(id,memberId,memberId).first();
}

async function openMatch(db,memberId) {
  return db.prepare(`
    SELECT * FROM nyg_darts_matches
    WHERE status='open'
      AND (player1_id=? OR player2_id=?)
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(memberId,memberId).first();
}

async function createMatch(db,p1,p2,type,rounds=3) {
  const id=crypto.randomUUID();
  const now=Date.now();

  await db.prepare(`
    INSERT INTO nyg_darts_matches (
      id,player1_id,player2_id,
      player1_name,player2_name,
      opponent_type,status,turn_player_id,
      round_no,round_deadline,rounds_total,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,'open',?,1,?,?,?,?)
  `).bind(
    id,p1.id,p2.id,p1.name,p2.name,
    type,p1.id,now+TURN_MS,rounds,now,now
  ).run();

  return getMatch(db,id);
}

function computerThrow() {
  const angle=(Math.random()-.5)*.48*Math.PI;
  const radius=Math.max(
    .08,Math.min(1.08,.52+(Math.random()-.5)*.72)
  );
  return {
    x:Math.sin(angle)*radius,
    y:-Math.cos(angle)*radius
  };
}


async function saveScores(db, row, time) {
  const week = weekStart(time);
  const date = new Date(time).toISOString();

  const players = [{
    id: row.player1_id,
    points: Number(row.player1_points)
  }];

  if (row.opponent_type === "online") {
    players.push({
      id: row.player2_id,
      points: Number(row.player2_points)
    });
  }

  const statements = players.map(p =>
    db.prepare(`
      INSERT OR IGNORE INTO nyg_darts_scores (
        id, match_id, member_id, week_start,
        points, opponent_type, created_at
      )
      SELECT ?, id, ?, ?, ?, opponent_type, ?
      FROM nyg_darts_matches
      WHERE id = ? AND status = 'complete'
    `).bind(
      crypto.randomUUID(),
      p.id,
      week,
      p.points,
      date,
      row.id
    )
  );

  await db.batch(statements);
}


async function finishMatch(db, row, time = Date.now()) {
  const latest = await getMatch(db, row.id);

  if (!latest) {
    throw new Error("Mechi haipatikani.");
  }

  const p1 = Number(latest.player1_points);
  const p2 = Number(latest.player2_points);

  const winner = p1 === p2
    ? null
    : p1 > p2
      ? latest.player1_id
      : latest.player2_id;

  const week = weekStart(time);
  const date = new Date(time).toISOString();

  const statements = [];

  if (latest.status === "open") {
    statements.push(
      db.prepare(`
        UPDATE nyg_darts_matches
        SET status = 'complete',
            winner_id = ?,
            round_deadline = 0,
            updated_at = ?
        WHERE id = ?
          AND status = 'open'
          AND updated_at = ?
      `).bind(
        winner, time, latest.id, latest.updated_at
      )
    );
  }

  statements.push(
    db.prepare(`
      INSERT OR IGNORE INTO nyg_darts_scores (
        id, match_id, member_id, week_start,
        points, opponent_type, created_at
      )
      SELECT ?, id, player1_id, ?,
             player1_points, opponent_type, ?
      FROM nyg_darts_matches
      WHERE id = ? AND status = 'complete'
    `).bind(
      crypto.randomUUID(), week, date, latest.id
    )
  );

  if (latest.opponent_type === "online") {
    statements.push(
      db.prepare(`
        INSERT OR IGNORE INTO nyg_darts_scores (
          id, match_id, member_id, week_start,
          points, opponent_type, created_at
        )
        SELECT ?, id, player2_id, ?,
               player2_points, opponent_type, ?
        FROM nyg_darts_matches
        WHERE id = ? AND status = 'complete'
      `).bind(
        crypto.randomUUID(), week, date, latest.id
      )
    );

    statements.push(
      db.prepare(`
        DELETE FROM nyg_darts_player_locks
        WHERE match_id = ?
          AND EXISTS (
            SELECT 1 FROM nyg_darts_matches
            WHERE id = ?
              AND status = 'complete'
          )
      `).bind(latest.id, latest.id)
    );
  }

  await db.batch(statements);

  return await getMatch(db, latest.id);
}


async function updateMatchClock(db,initial) {
  let row=initial;

  for(let i=0;i<100;i++) {
    if(!row||row.status!=="open")return row;

    const now=Date.now();
    const deadline=Number(row.round_deadline);

    if(deadline>now)break;

    const isP2=row.turn_player_id===row.player2_id;
    const total=Number(row.rounds_total||3);
    const round=Number(row.round_no);

    if(isP2&&round>=total) {
      const finished=await finishMatch(db,row,now);
      if(finished.status==="complete")return finished;
      row=finished;
      continue;
    }

    const nextPlayer=isP2
      ?row.player1_id:row.player2_id;
    const nextRound=isP2?round+1:round;

    await db.prepare(`
      UPDATE nyg_darts_matches
      SET turn_player_id=?,
          round_no=?,
          round_deadline=?,
          player1_visit=0,
          player2_visit=0,
          updated_at=?
      WHERE id=? AND status='open'
        AND round_deadline=?
        AND turn_player_id=?
        AND updated_at=?
    `).bind(
      nextPlayer,nextRound,
      deadline+TURN_MS,now,
      row.id,deadline,row.turn_player_id,row.updated_at
    ).run();

    row=await getMatch(db,row.id);
  }

  if(
    row.status==="open" &&
    row.opponent_type==="computer" &&
    row.turn_player_id===row.player2_id &&
    Date.now()-Number(row.updated_at)>=1900
  ) {
    const point=computerThrow();
    const now=Date.now();

    const dart={
      id:crypto.randomUUID(),
      created_at:now,
      ...point,
      ...scoreThrow(point.x,point.y)
    };

    const throws=json(row.player2_throws);
    throws.push(dart);

    await db.prepare(`
      UPDATE nyg_darts_matches
      SET player2_points=player2_points+?,
          player2_throws=?,
          updated_at=?
      WHERE id=? AND status='open'
        AND turn_player_id=?
        AND round_deadline>?
        AND updated_at=?
    `).bind(
      dart.points,JSON.stringify(throws),now,
      row.id,row.player2_id,now,row.updated_at
    ).run();

    row=await getMatch(db,row.id);
  }

  return row;
}

async function expireInvites(db) {
  const now=Date.now();
  await db.prepare(`
    UPDATE nyg_darts_invites
    SET status='expired',updated_at=?
    WHERE status='pending' AND created_at<?
  `).bind(now,now-INVITE_MS).run();
}

async function getBusy(db,a,b) {
  return db.prepare(`
    SELECT id FROM nyg_darts_matches
    WHERE status='open'
      AND (
        player1_id IN (?,?)
        OR player2_id IN (?,?)
      )
    LIMIT 1
  `).bind(a,b,a,b).first();
}

async function getPending(db,a,b) {
  return db.prepare(`
    SELECT id FROM nyg_darts_invites
    WHERE status='pending'
      AND (
        sender_id IN (?,?)
        OR receiver_id IN (?,?)
      )
    LIMIT 1
  `).bind(a,b,a,b).first();
}

const PRIZES={1:3000,2:2000,3:1000};

async function leaderboard(db,start) {
  const data=await db.prepare(`
    SELECT
      s.member_id,
      COALESCE(m.full_name,'Mwanachama') AS full_name,
      SUM(s.points) AS points,
      COUNT(*) AS matches_played,
      MAX(s.points) AS best_match,
      COUNT(DISTINCT DATE(s.created_at,'+3 hours'))
        AS days_played
    FROM nyg_darts_scores s
    LEFT JOIN members m ON m.id=s.member_id
    WHERE s.week_start=?
      AND s.opponent_type='computer'
    GROUP BY s.member_id,m.full_name
    ORDER BY
      points DESC,
      matches_played DESC,
      full_name COLLATE NOCASE ASC,
      s.member_id ASC
    LIMIT 5
  `).bind(start).all();

  return (data.results||[]).map((r,i)=>{
    const rank=i+1;
    const days=Number(r.days_played||0);
    const eligible=rank<=3&&days>=3;

    return {
      rank,
      member_id:r.member_id,
      full_name:r.full_name,
      points:Number(r.points||0),
      matches_played:Number(r.matches_played||0),
      best_match:Number(r.best_match||0),
      days_played:days,
      required_days:3,
      prize_amount:PRIZES[rank]||0,
      prize_type:rank<=3?"DATA BUNDLE":null,
      prize_eligible:eligible,
      prize_status:rank>3
        ?"NO_PRIZE"
        :eligible?"ELIGIBLE":"NOT_ELIGIBLE",
      prize_message:rank>3
        ?"Hongera kwa kushiriki NYG DARTS."
        :eligible
          ?"Hongera! Umekidhi masharti ya zawadi."
          :"Hujakidhi sharti la kucheza siku 3 tofauti."
    };
  });
}

export async function handleDartsApi(
  request,env,url,path,method,tools
) {
  if(!path.startsWith("/api/darts/"))return null;

  const reply=tools.reply;

  const db=env.MEMBERS_DB;
  if(!db) {
    return reply({
      error:"MEMBERS_DB haijaunganishwa."
    },503);
  }

  try {
    await ensureTables(db);
  }catch(error) {
    console.error("DARTS SCHEMA",error);
    return reply({
      error:"Hifadhi ya NYG DARTS haijapatikana."
    },503);
  }

  if(path==="/api/darts/leaderboard"&&method==="GET") {
    try {
      const current=weekStart(Date.now());
      const previous=new Date(
        Date.parse(current)-WEEK
      ).toISOString();

      return reply({
        week_start:current,
        next_reset_at:new Date(
          Date.parse(current)+WEEK
        ).toISOString(),
        leaderboard:await leaderboard(db,current),
        previous_week:{
          week_start:previous,
          winners:await leaderboard(db,previous)
        }
      });
    }catch(error) {
      console.error(error);
      return reply({error:"Leaderboard haipatikani."},500);
    }
  }

  if(path==="/api/darts/online-results"&&method==="GET") {
    try {
      const start=Date.parse(weekStart(Date.now()));
      const end=start+WEEK;

      const result=await db.prepare(`
        SELECT *
        FROM nyg_darts_matches
        WHERE opponent_type='online'
          AND status='complete'
          AND updated_at>=?
          AND updated_at<?
        ORDER BY updated_at DESC,id DESC
        LIMIT 100
      `).bind(start,end).all();

      const matches=(result.results||[]).map(r=>{
        const winner=r.winner_id===r.player1_id
          ?r.player1_name
          :r.winner_id===r.player2_id
            ?r.player2_name:null;

        return {
          id:r.id,
          match_id:r.id,
          player1:r.player1_name,
          player2:r.player2_name,
          player1_name:r.player1_name,
          player2_name:r.player2_name,
          player1_points:Number(r.player1_points),
          player2_points:Number(r.player2_points),
          points1:Number(r.player1_points),
          points2:Number(r.player2_points),
          winner,
          winner_name:winner,
          winner_id:r.winner_id,
          tie:!r.winner_id,
          rounds_total:Number(r.rounds_total||5),
          completed_at:new Date(
            Number(r.updated_at)
          ).toISOString()
        };
      });

      return reply({
        week_start:new Date(start).toISOString(),
        next_reset_at:new Date(end).toISOString(),
        total_matches:matches.length,
        matches,
        results:matches
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Matokeo ya ONLINE hayapatikani."
      },500);
    }
  }

  const member=await tools.getMember(request,env);

  if(!member) {
    return reply({
      error:"Ingia au jisajili kwanza."
    },401);
  }

  if(method==="POST"&&!tools.sameOrigin(request,url)) {
    return reply({
      error:"Ombi halijaruhusiwa."
    },403);
  }

  const memberId=String(member.id);
  const memberName=member.full_name||"Mwanachama";

  if(path==="/api/darts/presence"&&method==="POST") {
    const now=Date.now();

    await db.prepare(`
      INSERT INTO nyg_darts_presence
      (member_id,full_name,last_seen)
      VALUES (?,?,?)
      ON CONFLICT(member_id)
      DO UPDATE SET
        full_name=excluded.full_name,
        last_seen=excluded.last_seen
    `).bind(memberId,memberName,now).run();

    return reply({success:true,online:true});
  }

  if(path==="/api/darts/online-players"&&method==="GET") {
    try {
      await expireInvites(db);
      const now=Date.now();

      const result=await db.prepare(`
        SELECT
          p.member_id AS id,
          p.full_name AS name,
          CASE WHEN EXISTS (
            SELECT 1 FROM nyg_darts_matches m
            WHERE m.status='open'
              AND (
                m.player1_id=p.member_id
                OR m.player2_id=p.member_id
              )
          ) OR EXISTS (
            SELECT 1 FROM nyg_darts_invites i
            WHERE i.status='pending'
              AND (
                i.sender_id=p.member_id
                OR i.receiver_id=p.member_id
              )
          ) THEN 1 ELSE 0 END AS busy
        FROM nyg_darts_presence p
        WHERE p.member_id<>?
          AND p.last_seen>?
        ORDER BY p.full_name COLLATE NOCASE ASC
      `).bind(memberId,now-ONLINE_MS).all();

      return reply({
        players:(result.results||[]).map(p=>({
          id:p.id,
          name:p.name,
          online:true,
          busy:Number(p.busy)===1
        }))
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Wachezaji online hawapatikani."
      },500);
    }
  }

  if(path==="/api/darts/invite"&&method==="POST") {
    try {
      await expireInvites(db);

      const data=await request.json().catch(()=>({}));
      const receiverId=String(data.receiver_id||"");
      const rounds=Number(data.rounds);

      if(
        !receiverId||
        receiverId===memberId||
        !Number.isInteger(rounds)||
        rounds<5||rounds>10
      ) {
        return reply({
          error:"Chagua mchezaji na raundi 5–10."
        },400);
      }

      const now=Date.now();

      const receiver=await db.prepare(`
        SELECT member_id,full_name
        FROM nyg_darts_presence
        WHERE member_id=? AND last_seen>?
      `).bind(receiverId,now-ONLINE_MS).first();

      if(!receiver) {
        return reply({
          error:"Mchezaji hayupo online."
        },404);
      }

      if(await getBusy(db,memberId,receiverId)) {
        return reply({
          error:"Mmoja wenu ana mechi inayoendelea."
        },409);
      }

      if(await getPending(db,memberId,receiverId)) {
        return reply({
          error:"Kuna mwaliko unaosubiri majibu."
        },409);
      }

      const id=crypto.randomUUID();

      await db.prepare(`
        INSERT INTO nyg_darts_invites (
          id,sender_id,receiver_id,rounds,
          status,created_at,updated_at
        ) VALUES (?,?,?,?,'pending',?,?)
      `).bind(
        id,memberId,receiverId,rounds,now,now
      ).run();

      return reply({
        success:true,
        invite_id:id,
        receiver_name:receiver.full_name,
        rounds,
        status:"pending"
      });
    }catch(error) {
      console.error(error);
      return reply({error:"Mwaliko haukutumwa."},500);
    }
  }

  if(path==="/api/darts/invitations"&&method==="GET") {
    try {
      await expireInvites(db);

      const data=await db.prepare(`
        SELECT
          i.id,i.sender_id,i.rounds,i.created_at,
          COALESCE(p.full_name,'Mwanachama')
            AS sender_name
        FROM nyg_darts_invites i
        LEFT JOIN nyg_darts_presence p
          ON p.member_id=i.sender_id
        WHERE i.receiver_id=?
          AND i.status='pending'
        ORDER BY i.created_at DESC
      `).bind(memberId).all();

      return reply({
        invitations:(data.results||[]).map(r=>({
          ...r,
          rounds:Number(r.rounds)
        }))
      });
    }catch(error) {
      console.error(error);
      return reply({error:"Mialiko haipatikani."},500);
    }
  }

  if(path==="/api/darts/decline-invite"&&method==="POST") {
    const data=await request.json().catch(()=>({}));
    const id=String(data.invite_id||"");

    await expireInvites(db);

    const result=await db.prepare(`
      UPDATE nyg_darts_invites
      SET status='declined',updated_at=?
      WHERE id=? AND receiver_id=?
        AND status='pending'
    `).bind(Date.now(),id,memberId).run();

    if(Number(result.meta?.changes||0)!==1) {
      return reply({
        error:"Mwaliko haupo au umeshajibiwa."
      },409);
    }

    return reply({success:true,status:"declined"});
  }

  if(path==="/api/darts/accept-invite"&&method==="POST") {
    const data=await request.json().catch(()=>({}));
    const id=String(data.invite_id||"");

    try {
      await expireInvites(db);

      const invite=await db.prepare(`
        SELECT * FROM nyg_darts_invites
        WHERE id=? AND receiver_id=?
          AND status='pending'
      `).bind(id,memberId).first();

      if(!invite) {
        return reply({
          error:"Mwaliko haupo au umeshajibiwa."
        },409);
      }

      const now=Date.now();

      const sender=await db.prepare(`
        SELECT member_id,full_name
        FROM nyg_darts_presence
        WHERE member_id=? AND last_seen>?
      `).bind(invite.sender_id,now-ONLINE_MS).first();

      if(!sender) {
        return reply({
          error:"Aliyekualika hayupo online."
        },409);
      }

      if(await getBusy(db,invite.sender_id,memberId)) {
        return reply({
          error:"Mchezaji huyu yupo kwenye mechi na mchezaji mwingine. Tafadhali subiri amalize."
        },409);
      }

      const rounds=Number(invite.rounds);

      if(rounds<5||rounds>10) {
        return reply({error:"Raundi si sahihi."},400);
      }

      
      const matchId = crypto.randomUUID();

      try {
        await db.batch([
          
          db.prepare(`
            INSERT INTO nyg_darts_player_locks
              (member_id, match_id, created_at)
            SELECT ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM nyg_darts_invites
              WHERE id = ?
                AND receiver_id = ?
                AND status = 'pending'
            )
          `).bind(
            invite.sender_id, matchId, now,
            id, memberId
          ),


          db.prepare(`
            INSERT INTO nyg_darts_player_locks
              (member_id, match_id, created_at)
            VALUES (?, ?, ?)
          `).bind(memberId, matchId, now),

          db.prepare(`
            INSERT INTO nyg_darts_matches (
              id, player1_id, player2_id,
              player1_name, player2_name,
              opponent_type, status, turn_player_id,
              round_no, round_deadline, rounds_total,
              created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?,
                   'online', 'open', ?,
                   1, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM nyg_darts_invites
              WHERE id = ?
                AND receiver_id = ?
                AND status = 'pending'
            )
          `).bind(
            matchId,
            sender.member_id,
            memberId,
            sender.full_name,
            memberName,
            sender.member_id,
            now + TURN_MS,
            rounds,
            now,
            now,
            id,
            memberId
          ),

          db.prepare(`
            UPDATE nyg_darts_invites
            SET status = 'accepted',
                match_id = ?,
                updated_at = ?
            WHERE id = ?
              AND receiver_id = ?
              AND status = 'pending'
          `).bind(matchId, now, id, memberId)
        ]);
      } catch (error) {
        return reply({
          error: "Mchezaji huyu yupo kwenye mechi na mchezaji mwingine. Tafadhali subiri amalize."
        }, 409);
      }


      const match=await getMatch(db,matchId);

      return reply({
        success:true,
        status:"accepted",
        match:matchView(match,memberId)
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Mwaliko haukukubaliwa."
      },500);
    }
  }

  if(path==="/api/darts/active"&&method==="GET") {
    try {
      const row=await openMatch(db,memberId);

      if(row) {
        const updated=await updateMatchClock(db,row);
        return reply({
          status:"match",
          match:matchView(updated,memberId)
        });
      }

      const recent=await db.prepare(`
        SELECT * FROM nyg_darts_matches
        WHERE status='complete'
          AND (player1_id=? OR player2_id=?)
          AND updated_at>?
        ORDER BY updated_at DESC
        LIMIT 1
      `).bind(
        memberId,memberId,Date.now()-30000
      ).first();

      if(recent) {
        return reply({
          status:"match",
          match:matchView(recent,memberId)
        });
      }

      return reply({status:"idle"});
    }catch(error) {
      console.error(error);
      return reply({
        error:"Hali ya mechi haipatikani."
      },500);
    }
  }

  if(path==="/api/darts/matchmaking"&&method==="POST") {
    return reply({
      error:"ONLINE DARTS hutumia INVITE na ACCEPT."
    },409);
  }

  if(path==="/api/darts/computer"&&method==="POST") {
    try {
      const existing=await openMatch(db,memberId);

      if(existing) {
        const updated=await updateMatchClock(db,existing);
        return reply({
          status:"match",
          match:matchView(updated,memberId)
        });
      }

      const row=await createMatch(
        db,
        {id:memberId,name:memberName},
        {
          id:"computer-"+crypto.randomUUID(),
          name:"Kompyuta"
        },
        "computer",3
      );

      await db.prepare(`
        DELETE FROM nyg_darts_queue WHERE member_id=?
      `).bind(memberId).run();

      return reply({
        status:"match",
        match:matchView(row,memberId)
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Mechi ya kompyuta haijaanza."
      },500);
    }
  }

  if(path==="/api/darts/match"&&method==="GET") {
    const id=url.searchParams.get("id")||
      url.searchParams.get("match_id")||"";

    const row=await memberMatch(db,id,memberId);

    if(!row) {
      return reply({error:"Mechi haipo."},404);
    }

    const updated=await updateMatchClock(db,row);
    return reply({match:matchView(updated,memberId)});
  }

  if(path==="/api/darts/finish"&&method==="POST") {
    const data=await request.json().catch(()=>({}));
    const id=String(data.match_id||"");

    try {
      const row=await memberMatch(db,id,memberId);

      if(!row) {
        return reply({error:"Mechi haipo."},404);
      }

      if(row.status==="complete") {
        return reply({match:matchView(row,memberId)});
      }

      const updated=await updateMatchClock(db,row);

      if(updated.status==="complete") {
        return reply({match:matchView(updated,memberId)});
      }

      if(updated.opponent_type==="online") {
        return reply({
          error:"ONLINE DARTS inamalizika baada ya raundi zote."
        },409);
      }

      const finished=await finishMatch(db,updated);

      return reply({
        match:matchView(finished,memberId)
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Imeshindikana kuhifadhi matokeo."
      },500);
    }
  }

  if(path==="/api/darts/throw"&&method==="POST") {
    const data=await request.json().catch(()=>({}));
    const id=String(data.match_id||"");
    const x=Number(data.x);
    const y=Number(data.y);

    if(
      !id||
      !Number.isFinite(x)||
      !Number.isFinite(y)||
      Math.abs(x)>1.5||
      Math.abs(y)>1.5
    ) {
      return reply({error:"Lengo si sahihi."},400);
    }

    try {
      const row=await memberMatch(db,id,memberId);

      if(!row||row.status!=="open") {
        return reply({
          error:"Mechi haipo au imeisha."
        },409);
      }

      const current=await updateMatchClock(db,row);

      if(current.status!=="open") {
        return reply({
          error:"Mechi imekamilika."
        },409);
      }

      if(current.turn_player_id!==memberId) {
        return reply({
          error:"Subiri zamu yako."
        },409);
      }

      const now=Date.now();
      const dart={
        id:crypto.randomUUID(),
        created_at:now,
        x,y,
        ...scoreThrow(x,y)
      };

      const isP1=memberId===current.player1_id;
      const throws=json(
        isP1
          ?current.player1_throws
          :current.player2_throws
      );
      throws.push(dart);

      const result=isP1
        ?await db.prepare(`
          UPDATE nyg_darts_matches
          SET player1_points=player1_points+?,
              player1_throws=?,
              updated_at=?
          WHERE id=? AND status='open'
            AND turn_player_id=?
            AND round_deadline>?
            AND updated_at=?
        `).bind(
          dart.points,JSON.stringify(throws),now,
          id,memberId,now,current.updated_at
        ).run()
        :await db.prepare(`
          UPDATE nyg_darts_matches
          SET player2_points=player2_points+?,
              player2_throws=?,
              updated_at=?
          WHERE id=? AND status='open'
            AND turn_player_id=?
            AND round_deadline>?
            AND updated_at=?
        `).bind(
          dart.points,JSON.stringify(throws),now,
          id,memberId,now,current.updated_at
        ).run();

      if(Number(result.meta?.changes||0)!==1) {
        return reply({
          error:"Zamu imebadilika. Jaribu tena."
        },409);
      }

      const saved=await getMatch(db,id);

      return reply({
        dart,
        match:matchView(saved,memberId)
      });
    }catch(error) {
      console.error(error);
      return reply({
        error:"Mshale haujahifadhiwa."
      },500);
    }
  }

  return reply({
    error:"Njia ya NYG DARTS haipatikani."
  },404);
}

export async function runDartsScheduled(env) {
  if (!env.MEMBERS_DB) {
    console.error("NYG DARTS: MEMBERS_DB haijaunganishwa.");
    return;
  }

  const db = env.MEMBERS_DB;

  await ensureTables(db);

  let processed = 0;

  for (let page = 0; page < 10; page++) {
    const now = Date.now();

    const result = await db.prepare(`
      SELECT *
      FROM nyg_darts_matches
      WHERE status = 'open'
        AND round_deadline > 0
        AND round_deadline <= ?
      ORDER BY round_deadline ASC
      LIMIT 50
    `).bind(now).all();

    const matches = result.results || [];

    if (matches.length === 0) break;

    for (const match of matches) {
      try {
        await updateMatchClock(db, match);
        processed++;
      } catch (error) {
        console.error(
          "NYG DARTS: Hitilafu ya mechi",
          match.id,
          error
        );
      }
    }

    if (matches.length < 50) break;
  }

  console.log(
    "NYG DARTS: Mechi zilizokaguliwa:",
    processed
  );
}

