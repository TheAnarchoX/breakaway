# Freeze, gates, and locks

> The switches that stop changes: freeze, which stops every plan on an environment and pauses production’s deploys, production gates, observe only, and the lock that lets one apply run at a time.

## Freeze

**Freeze** stops every plan on one environment, envelopes and scaling rules included, until you unfreeze it. It’s the one switch: there are no change windows.

**Freeze** and **Unfreeze** are on each environment’s row on Infrastructure, on its page, and on the repository’s settings page under Infrastructure. Each asks first:

- “Freeze production? Freezing production pauses deploys and plans; Roll back still works.”
- “Freeze staging? Freezing staging stops plans; merges still deploy here.”

While an environment is frozen:

- **Every plan is refused**, by the policy’s first guard. A plan that waits for you can’t be approved: “Staging is frozen: unfreeze it to approve.”
- **You can still change it on the console and propose the change.** Approve waits for Unfreeze.
- **Drift is shown, and planned once you unfreeze.** What nobody owns waits too.
- **On the deploy flow, freezing production is the deploy pause**: Promote and Release stop, and Roll back still works ([Architect and the deploy flow](https://leavethepack.dev/docs/architect-deploy-flow/#freeze-is-the-deploy-pause)).

Freeze when you want nothing to move while you look: during an incident, while you change something by hand, or before a launch. Each freeze and unfreeze is in the environment’s audit trail.

## Production gates

An environment with **production gates** makes every plan there wait for you, whatever your policy’s allow rules say, and makes its incidents push to your phone. A production environment has them unless you turn them off; you can give them to any other. An [envelope](https://leavethepack.dev/docs/architect-envelopes/) still works under production gates: it’s bounds you approved already.

## Observe only

An **observe-only** environment is one the board watches and never changes: it shows what runs, its health, and its cost, and takes no desired state, plan, envelope, or apply. A file for one is refused, and nothing in it is flagged as nobody owns.

**The board’s own install is always observe only**, whatever the switch says. Architect never applies to it: its fix is a pull request to its code, deployed the way the board always is, and its way back is [Recover without the board](https://leavethepack.dev/docs/recovery/).

Freeze, production gates, and observe only are yours alone, from the signed-in board: the token agents and the CLI hold can’t set them.

## The lock

One apply runs at a time per environment. When a plan starts, the board takes the environment’s **lock** for 15 minutes and renews it while the apply works; a lock nobody renews frees itself within the hour.

While one is held, the environment’s page says which plan holds it. Another approved plan stays **Approved**, saying it waits for the lock, and starts once the lock is free.

**Release the lock**, under the environment’s status band, frees it by force. Use it only when you know the run holding it has stopped: it asks first, since the next approved plan can start at once. The release goes in the audit trail.
