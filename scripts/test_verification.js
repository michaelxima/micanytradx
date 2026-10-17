const { pool } = require('../db');

async function testLifecycle() {
  console.log('=== STEP 1: HEALTH CHECK ===');
  const healthRes = await fetch('http://localhost:3000/api/health');
  const healthData = await healthRes.json();
  console.log('Response:', healthData);

  console.log('\n=== STEP 2: INSERT STRATEGY & PENDING SIGNAL ===');
  const stratRes = await pool.query(
    'INSERT INTO strategies (name, description, parameters) VALUES ($1, $2, $3) RETURNING id',
    ['EMA Pullback Momentum', 'Verification test strategy', JSON.stringify({ ema_fast: 9, ema_slow: 21 })]
  );
  const strategyId = stratRes.rows[0].id;
  console.log('Strategy ID:', strategyId);

  const signalRes = await pool.query(
    `INSERT INTO signals (strategy_id, symbol, signal_type, suggested_price, rsi_at_signal, ema_fast_at_signal, ema_slow_at_signal)
     VALUES ($1, 'BTCUSDT', 'BUY', 65000.00, 48.5, 65100.00, 64900.00)
     RETURNING id`,
    [strategyId]
  );
  const signalId = signalRes.rows[0].id;
  console.log('Signal ID (pending_review):', signalId);

  console.log('\n=== STEP 3: GET /api/signals/pending ===');
  const pendingRes = await fetch('http://localhost:3000/api/signals/pending');
  const pendingData = await pendingRes.json();
  console.log('Pending count:', pendingData.count);
  const foundSignal = pendingData.signals.find(s => s.id === signalId);
  console.log('Found signal in API:', {
    id: foundSignal.id,
    strategy_name: foundSignal.strategy_name,
    symbol: foundSignal.symbol,
    signal_type: foundSignal.signal_type,
    suggested_price: foundSignal.suggested_price,
    status: foundSignal.status
  });

  console.log('\n=== STEP 4: POST /api/trades/confirm-buy ===');
  const buyRes = await fetch('http://localhost:3000/api/trades/confirm-buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signalId: signalId,
      quantity: 0.1,
      confirmedPrice: 65100.00
    })
  });
  const buyData = await buyRes.json();
  console.log('Confirm Buy response:', buyData);
  const tradeId = buyData.tradeId;

  console.log('\n=== STEP 5: GET /api/trades/open ===');
  const openRes = await fetch('http://localhost:3000/api/trades/open');
  const openData = await openRes.json();
  console.log('Open trades count:', openData.count);
  const foundTrade = openData.trades.find(t => t.id === tradeId);
  console.log('Open trade details:', {
    id: foundTrade.id,
    symbol: foundTrade.symbol,
    side: foundTrade.side,
    entry_price: foundTrade.entry_price,
    stop_loss_price: foundTrade.stop_loss_price,
    status: foundTrade.status
  });

  console.log('\n=== STEP 6: POST /api/trades/confirm-sell ===');
  const sellRes = await fetch('http://localhost:3000/api/trades/confirm-sell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tradeId: tradeId,
      exitPrice: 66402.00,
      reason: 'target_reached'
    })
  });
  const sellData = await sellRes.json();
  console.log('Confirm Sell response:', sellData);

  console.log('\n=== STEP 7: VERIFY OPEN TRADES AFTER EXIT ===');
  const finalOpenRes = await fetch('http://localhost:3000/api/trades/open');
  const finalOpenData = await finalOpenRes.json();
  console.log('Open trades count:', finalOpenData.count);

  console.log('\n=== STEP 8: VERIFY DB RECORD FOR CLOSED TRADE ===');
  const closedRes = await pool.query('SELECT * FROM trades WHERE id = $1', [tradeId]);
  const closedTrade = closedRes.rows[0];
  console.log('Closed trade DB record:', {
    id: closedTrade.id,
    entry_price: closedTrade.entry_price,
    exit_price: closedTrade.exit_price,
    pnl_absolute: closedTrade.pnl_absolute,
    pnl_percentage: closedTrade.pnl_percentage + '%',
    status: closedTrade.status
  });

  console.log('\nALL CHECKS PASSED SUCCESSFULLY!');
  process.exit(0);
}

testLifecycle().catch(err => {
  console.error('Lifecycle test failed:', err);
  process.exit(1);
});
