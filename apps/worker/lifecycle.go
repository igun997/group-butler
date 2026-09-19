package main

import (
	"context"
	"time"
)

// This file is what is left of the instance lifecycle now that the worker holds
// no WhatsApp session: the periodic group reconcile, and the status write the
// console's instance row still needs.
//
// Everything else that used to live here — pairing, QR material, boot restore,
// on-demand reconnect, logout and the device-store reads behind them — existed
// to own a linked device. Hermes owns it now (hermes_bridge.go), the console
// pairs through the BFF's wizard, and nothing in this worker may open a socket,
// so those paths are gone rather than disabled.

// markStatus persists a runtime status change on the instance row. It is the
// worker's only instance write; there is no live session to mirror it onto.
func (m *manager) markStatus(ctx context.Context, id string, status sessionState, pairingError string) error {
	return m.instances.SetStatus(ctx, m.orgID, id, status, pairingError)
}

// runGroupSyncOnce performs one full sync for the deployment's instance under its
// own deadline. The membership comes from the bridge, which is the account the
// console actually uses; a worker without a bridge address has nothing to ask and
// reports why rather than recording an empty membership.
func (m *manager) runGroupSyncOnce(ctx context.Context, source SyncSource) error {
	instanceID := m.cfg.HermesInstanceID
	if m.bridge == nil {
		return errNoBridge
	}
	ctx, cancel := context.WithTimeout(ctx, groupSyncTimeout)
	defer cancel()
	summary, err := runGroupSync(ctx, m.bridge, m.groups, m.orgID, instanceID, source, m.cfg.GroupSyncPrune)
	if err != nil {
		logf("instance %s: group sync (%s): %v", instanceID, source, err)
		m.recordGroupSyncError(ctx, instanceID, err.Error())
		return err
	}
	// Only a snapshot that arrived describes the membership; a refused sync must
	// leave the last observed total standing rather than reporting the refusal as
	// an empty membership.
	m.recordGroupSync(ctx, instanceID, summary)
	logf("instance %s: group sync (%s): %d group(s), %d added, %d marked left",
		instanceID, source, summary.Total, summary.Added, summary.MarkedLeft)
	return nil
}

// runGroupSyncScheduler performs the periodic full reconcile (§6.6.2) until its
// context is cancelled. It is the offline-rename safety net: without it, a rename
// that happened while the worker was down would go unseen.
func (m *manager) runGroupSyncScheduler(ctx context.Context) {
	ticks, stop := m.newTicker(m.cfg.GroupSyncInterval)
	defer stop()
	logf("group sync scheduler started (every %s)", m.cfg.GroupSyncInterval)
	m.loops.declare(loopGroupSync, m.cfg.GroupSyncInterval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			m.loops.pass(loopGroupSync, time.Now(), m.runGroupSyncOnce(ctx, SyncOnTimer))
		}
	}
}

// groupSyncTimeout bounds one full reconcile. A bridge that stops answering must
// fail the pass rather than hold the loop, and the next tick retries.
const groupSyncTimeout = time.Minute
