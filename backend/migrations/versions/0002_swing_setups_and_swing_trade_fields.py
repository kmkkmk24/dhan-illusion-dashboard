"""swing setups and swing trade fields

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-12 12:32:06.653707

Swing engine: swing_setups (setup lifecycle + forward-tested outcome) and swing
fields on trades (setup link, entry mode, initial SL, T1, trailing advice).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent: a half-applied earlier draft of this revision (SQLite commits DDL
    # statement by statement) may already have created swing_setups.
    insp = sa.inspect(op.get_bind())
    if not insp.has_table('swing_setups'):
        _create_swing_setups()
    have_idx = {i['name'] for i in insp.get_indexes('swing_setups')} if insp.has_table('swing_setups') else set()
    with op.batch_alter_table('swing_setups', schema=None) as batch_op:
        for name, cols in (('idx_swing_active', ['active', 'setup_type']),
                           ('idx_swing_sec_type', ['security_id', 'setup_type', 'active']),
                           ('ix_swing_setups_eval_status', ['eval_status']),
                           ('ix_swing_setups_security_id', ['security_id']),
                           ('ix_swing_setups_suggested_on', ['suggested_on'])):
            if name not in have_idx:
                batch_op.create_index(name, cols, unique=False)

    have_cols = {c['name'] for c in insp.get_columns('trades')}
    new_cols = [
        sa.Column('setup_id', sa.Integer(), nullable=True),
        sa.Column('setup_type', sa.String(length=10), nullable=True),
        sa.Column('entry_mode', sa.String(length=10), nullable=True),
        sa.Column('initial_sl', sa.Float(), nullable=True),
        sa.Column('t1_price', sa.Float(), nullable=True),
        sa.Column('t1_done', sa.Boolean(), nullable=True),
        sa.Column('peak_price', sa.Float(), nullable=True),
        sa.Column('exit_reason', sa.String(length=60), nullable=True),
        sa.Column('advice', sa.Text(), nullable=True),
        sa.Column('protection_note', sa.String(length=200), nullable=True),
    ]
    if 'setup_id' not in have_cols or any(c.name not in have_cols for c in new_cols):
        with op.batch_alter_table('trades', schema=None) as batch_op:
            for col in new_cols:
                if col.name not in have_cols:
                    batch_op.add_column(col)
            batch_op.create_index('ix_trades_setup_id', ['setup_id'], unique=False)
            batch_op.create_foreign_key('fk_trades_setup_id', 'swing_setups', ['setup_id'], ['id'])


def _create_swing_setups() -> None:
    op.create_table('swing_setups',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('security_id', sa.String(length=20), nullable=False),
    sa.Column('symbol', sa.String(length=50), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=True),
    sa.Column('setup_type', sa.String(length=10), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('tier', sa.String(length=3), nullable=True),
    sa.Column('score', sa.Float(), nullable=True),
    sa.Column('components', sa.Text(), nullable=True),
    sa.Column('reasons', sa.Text(), nullable=True),
    sa.Column('warnings', sa.Text(), nullable=True),
    sa.Column('detail', sa.Text(), nullable=True),
    sa.Column('sector', sa.String(length=50), nullable=True),
    sa.Column('sector_rank', sa.Integer(), nullable=True),
    sa.Column('rs_rating', sa.Integer(), nullable=True),
    sa.Column('regime', sa.String(length=12), nullable=True),
    sa.Column('close', sa.Float(), nullable=True),
    sa.Column('entry', sa.Float(), nullable=True),
    sa.Column('stop', sa.Float(), nullable=True),
    sa.Column('target1', sa.Float(), nullable=True),
    sa.Column('target2', sa.Float(), nullable=True),
    sa.Column('risk_pct', sa.Float(), nullable=True),
    sa.Column('top_pick', sa.Boolean(), nullable=True),
    sa.Column('dismissed', sa.Boolean(), nullable=True),
    sa.Column('first_seen', sa.Date(), nullable=False),
    sa.Column('last_seen', sa.Date(), nullable=False),
    sa.Column('suggested_on', sa.Date(), nullable=True),
    sa.Column('plan_entry', sa.Float(), nullable=True),
    sa.Column('plan_stop', sa.Float(), nullable=True),
    sa.Column('plan_t1', sa.Float(), nullable=True),
    sa.Column('plan_t2', sa.Float(), nullable=True),
    sa.Column('plan_score', sa.Float(), nullable=True),
    sa.Column('plan_tier', sa.String(length=3), nullable=True),
    sa.Column('plan_regime', sa.String(length=12), nullable=True),
    sa.Column('plan_top_pick', sa.Boolean(), nullable=True),
    sa.Column('eval_status', sa.String(length=16), nullable=True),
    sa.Column('triggered_on', sa.Date(), nullable=True),
    sa.Column('fill_price', sa.Float(), nullable=True),
    sa.Column('exit_on', sa.Date(), nullable=True),
    sa.Column('exit_price', sa.Float(), nullable=True),
    sa.Column('result_r', sa.Float(), nullable=True),
    sa.Column('mfe_r', sa.Float(), nullable=True),
    sa.Column('mae_r', sa.Float(), nullable=True),
    sa.Column('days_held', sa.Integer(), nullable=True),
    sa.Column('t1_hit', sa.Boolean(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('trades', schema=None) as batch_op:
        batch_op.drop_constraint('fk_trades_setup_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_trades_setup_id'))
        batch_op.drop_column('protection_note')
        batch_op.drop_column('advice')
        batch_op.drop_column('exit_reason')
        batch_op.drop_column('peak_price')
        batch_op.drop_column('t1_done')
        batch_op.drop_column('t1_price')
        batch_op.drop_column('initial_sl')
        batch_op.drop_column('entry_mode')
        batch_op.drop_column('setup_type')
        batch_op.drop_column('setup_id')

    with op.batch_alter_table('swing_setups', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_swing_setups_suggested_on'))
        batch_op.drop_index(batch_op.f('ix_swing_setups_security_id'))
        batch_op.drop_index(batch_op.f('ix_swing_setups_eval_status'))
        batch_op.drop_index('idx_swing_sec_type')
        batch_op.drop_index('idx_swing_active')

    op.drop_table('swing_setups')
    # ### end Alembic commands ###
