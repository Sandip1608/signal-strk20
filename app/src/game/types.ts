/**
 * Types mirroring `contracts/src/round.cairo`.
 *
 * Field names and semantics follow the Cairo storage exactly — including the
 * `seat + 1` sentinel encoding (0 = "nobody"), which is preserved rather than
 * normalised to -1 so that a value read straight off the contract can be
 * dropped in without translation.
 */

/** `round.cairo::phases`. */
export const Phase = {
  LOBBY: 0,
  ASSIGNED: 1,
  NIGHT: 2,
  VOTE: 3,
  RESOLVED: 4,
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export const PHASE_LABEL: Record<PhaseValue, string> = {
  [Phase.LOBBY]: "Lobby",
  [Phase.ASSIGNED]: "Roles assigned",
  [Phase.NIGHT]: "Night",
  [Phase.VOTE]: "Vote",
  [Phase.RESOLVED]: "Resolved",
};

/** `SignalRound::FLOOR_PLAYERS` / `CEIL_PLAYERS` — the outer bounds any
 * variant must sit inside. Per-round limits come from the variant config. */
export const FLOOR_PLAYERS = 3;
export const CEIL_PLAYERS = 15;

/** `round.cairo::NO_SEAT` — the 0 sentinel in `seat + 1` fields. */
export const NO_SEAT = 0;

/**
 * "IMPOSTOR" is the hidden team in every variant; the display name (Werewolf,
 * Fascist, Minion of Mordred) comes from the variant config, so the engine
 * only ever reasons about hidden-vs-not.
 */
export type Role = "CREW" | "IMPOSTOR" | "SEER";

/**
 * One seat. `wallet` is the lobby-join address that shielded the buy-in;
 * `sessionKey` is the burner that signs in-round actions. The contract rejects
 * `join` when they are equal — that inequality is the whole unlinkability
 * claim, so it is enforced client-side too rather than only on-chain.
 */
export type Seat = {
  seat: number;
  /** Display handle. Purely local — the contract stores no names. */
  name: string;
  /**
   * Filled by the bot driver rather than a person. Purely a client concern —
   * on-chain a bot seat is an ordinary seat with its own burner key, and the
   * contract cannot tell the difference.
   */
  isBot: boolean;
  wallet: string;
  sessionKey: string;
  /** Burner private key, held only in this browser. Never sent anywhere. */
  sessionPrivateKey: string;
  /** Pre-created STRK20 open note (phase 5) the payout lands in. */
  payoutNoteId: string;
  /** Public randomness this player contributed at `join`. */
  entropy: string;
  dead: boolean;
  /**
   * Delivered as a 0-value encrypted note only this holder can decrypt.
   * Undefined until the host assigns roles.
   */
  role?: Role;
  /** Whether this player has opened their role note yet. */
  roleSeen: boolean;
  /** Whether this seat's anonymous vote leg has been submitted. */
  hasVoted: boolean;
  /** One emergency meeting per player per round. */
  calledMeeting: boolean;
  /**
   * What this seat has investigated: target seat -> was an impostor.
   *
   * Private to the seer — the relay redacts it for everyone else, the same way
   * it redacts roles. Cumulative: a seer who cleared someone in round 1 would
   * still remember it in round 3, so the record should not be wiped either.
   */
  checks: Record<number, boolean>;
  /** `roundNumber` of the last check; -1 for none. Enforces one per night. */
  checkedRound: number;
};

export type GameState = {
  host: string;
  escrow: string;
  phase: PhaseValue;

  /** The contract's constructor arguments. */
  minPlayers: number;
  maxPlayers: number;
  hiddenCount: number;
  /** Investigative crew. Drawn from the same committed seed as the impostors. */
  seerCount: number;
  /**
   * Client-side round settings. Neither exists on-chain: the contract has no
   * concept of a task, and "confirm ejects" is purely how the reveal is
   * presented.
   */
  tasksPerPlayer: number;
  confirmEjects: boolean;

  seats: Seat[];

  /**
   * poseidon(host_seed) — posted in the constructor, before anyone joins, so
   * the host cannot aim the draw at a particular player.
   */
  seedCommitment: string;
  /** poseidon(hidden_seats…, salt), posted by the host in `assign_roles`. */
  roleCommitment: string;
  /**
   * Host-only secrets backing the commitment. Never leaves the host's client.
   * Ascending order is required — the commitment hashes the sequence, so
   * without a canonical order a team would have many valid preimages.
   */
  hiddenSeats: number[];
  /** Revealed with the rest at resolve. */
  seerSeats: number[];
  salt: string;
  /** Host-only until `resolve_round` reveals it. */
  hostSeed: string;

  nightDurationSecs: number;
  voteDurationSecs: number;
  /** Unix ms. 0 = not started. */
  nightDeadline: number;
  voteDeadline: number;

  /** Which round we are in, from 0. */
  roundNumber: number;
  /** round -> `seat + 1` ejected that round; 0 = nobody. */
  ejections: Record<number, number>;
  /**
   * round -> was the player ejected that round an impostor.
   *
   * Among Us's "Confirm Ejects". This is a *deliberate* public disclosure —
   * the whole point of the setting is that the table is told — which is why it
   * can live in mirrored state and be broadcast to everyone without redaction.
   * It never names the role, only guilty or not, and it is filled only when
   * `confirmEjects` is on and somebody was actually ejected.
   */
  ejectedWasImpostor: Record<number, boolean>;
  /**
   * seat -> tasks that seat has submitted. Mirrors `tasks_done` on-chain.
   *
   * Public by design: the contract counts these to decide the crew's own win
   * condition, and it can only tell crew from impostor once the roles open at
   * resolve — so it accepts submissions from anyone and discards the
   * impostors' at the end.
   *
   * Worth being clear about the cost. Among Us shows only the aggregate bar;
   * this is per seat, and on-chain storage is public, so a player who submits
   * nothing is visible as such. An impostor is dealt a full fake list and can
   * submit against it at the same rate, so keeping pace is free — the tell only
   * catches one who does not bother, which is the same read as "he was not
   * doing tasks" at a real table. Hiding it in the UI would be a lie about what
   * the chain shows.
   */
  tasksDone: Record<number, number>;
  /**
   * seat -> killed this round and not yet reported. Mirrors `unreported_body`.
   *
   * This is what keeps `reportBody` from becoming an unlimited emergency
   * meeting: without it anyone could "report" a corpse from three rounds ago,
   * or an ejected player, and open a vote at will.
   */
  unreportedBody: Record<number, boolean>;
  /** `seat + 1`; 0 = nobody died this round. */
  nightVictim: number;
  /**
   * `seat + 1` of a player who has been sent the kill note but has not yet
   * self-reported; 0 = none.
   *
   * This has no on-chain counterpart *by design* — it mirrors a note sitting
   * undecrypted in the victim's inbox inside the pool. The round contract
   * genuinely does not know a kill happened until `confirm_death`.
   */
  pendingVictim: number;

  /** seat -> accumulated vote weight. Public by design (RFP wants a computable tally). */
  tallies: Record<number, bigint>;
  /** Votes to eject nobody. */
  skipTally: bigint;
  totalVotes: bigint;

  /** `seat + 1`; 0 = tie / nobody ejected. */
  ejected: number;
  /** `seat + 1`; 0 until resolved. */
  impostorRevealed: number;
  crewWon: boolean;

  /** Append-only log of every action, for the demo reel and for debugging. */
  log: LogEntry[];
};

export type LogEntry = {
  at: number;
  /** Which on-chain call this corresponds to, or `pool` for in-pool actions. */
  call: string;
  text: string;
  /** Actions that are private in the real system are marked so the UI can say so. */
  private?: boolean;
};

/**
 * `round.cairo::SKIP_VOTE`. A vote that names nobody — the table declining to
 * eject. Kept identical to the Cairo sentinel so a skip is an ordinary
 * anonymous leg rather than a second entrypoint.
 */
export const SKIP_VOTE = 0xffffffff;

/**
 * `round.cairo::MAX_ROUNDS` - the stall cap on the host-driven loop.
 *
 * Permits 9 completed rounds, not 10: `endVote` asserts
 * `roundNumber + 1 < MAX_ROUNDS` and rounds count from 0. Reaching the cap is
 * terminal — `resolveRound` accepts it as a crew win — so it ends the game
 * rather than stranding it.
 */
export const MAX_ROUNDS = 10;

/** The buy-in / vote weight unit. One seat, one vote of equal weight in v1. */
export const VOTE_WEIGHT = 1n;
