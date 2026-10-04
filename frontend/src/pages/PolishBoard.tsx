/**
 * /polish 打磨与推光工序（打磨工位）
 * 打磨工位的底稿：登记磨料目数与手法耗时，记录挂到具体道次（coatId）名下。
 * 髹涂工序台推道次前只读这里的记录对牌，本页不回写道次状态（互不改对方那份）。
 * 事后补记只补 coatId 归属（按 bodyId+seq），不回退已罩漆道次；补不上的单列待认领。
 * 消费 Polish（polishStore）、Coat（只读）；复用 <StageTag>、<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { usePolishStore } from '@/stores/polishStore';
import {
  evaluateCoatGate,
  findPolishForCoat,
  selectUnclaimedPolishes,
  suggestFinerGrit,
} from '@/utils/polish';
import {
  GRIT_SEQUENCE,
  POLISH_METHOD_COLOR,
  POLISH_METHOD_LABEL,
  POLISH_METHOD_OPTIONS,
  createEmptyPolishDraft,
  type Polish,
  type PolishMethod,
} from '@/types/polish';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, type Coat } from '@/types/coat';

export default function PolishBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ coatId?: string; grit: number; method: PolishMethod; durationMin: number; operator: string }>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);

  const coats = useCoatStore((state) => state.coats);
  const polishes = usePolishStore((state) => state.polishes);
  const loadPolishes = usePolishStore((state) => state.loadPolishes);
  const createPolish = usePolishStore((state) => state.createPolish);
  const updatePolish = usePolishStore((state) => state.updatePolish);
  const removePolish = usePolishStore((state) => state.removePolish);
  const backfillCoatIds = usePolishStore((state) => state.backfillCoatIds);
  const claimPolish = usePolishStore((state) => state.claimPolish);

  const { progressOf } = useCoatProgress();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Polish | null>(null);
  /** 待认领记录挂接到某道次的选择（polishId -> coatId） */
  const [claimTarget, setClaimTarget] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadPolishes();
  }, [loadPolishes]);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  const rows = useMemo(
    () =>
      polishes
        .filter((row) => row.bodyId === bodyId)
        .sort((a, b) => (a.seq === b.seq ? a.grit - b.grit : a.seq - b.seq)),
    [polishes, bodyId],
  );

  /** 停在待打磨的道次：已进入待打磨但对牌未通过（无记录或目数未更细） */
  const stuckCoats = useMemo(
    () =>
      bodyCoats.filter(
        (coat) => coat.state === 'toPolish' && !evaluateCoatGate(coat, bodyCoats, rows).ok,
      ),
    [bodyCoats, rows],
  );

  /** 待认领：本胎体名下挂不到任何道次的打磨记录 */
  const unclaimed = useMemo(
    () => selectUnclaimedPolishes(rows, bodyCoats),
    [rows, bodyCoats],
  );

  const stat = bodyId ? progressOf(bodyId) : null;
  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMin, 0);
  const maxGrit = rows.reduce((max, row) => Math.max(max, row.grit), 0);

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择胎体');
      return;
    }
    if (bodyCoats.length === 0) {
      message.warning('请先到「髹涂道次」页编排道次，再按道次登记打磨记录');
      return;
    }
    setEditing(null);
    const firstCoat = bodyCoats[0] as Coat;
    const draft = createEmptyPolishDraft(bodyId, firstCoat.id, firstCoat.seq);
    form.setFieldsValue({
      coatId: firstCoat.id,
      grit: draft.grit,
      method: draft.method,
      durationMin: draft.durationMin,
      operator: draft.operator,
    });
    setOpen(true);
  };

  const openEdit = (row: Polish): void => {
    setEditing(row);
    form.setFieldsValue({
      coatId: row.coatId ?? undefined,
      grit: row.grit,
      method: row.method,
      durationMin: row.durationMin,
      operator: row.operator,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const coat = bodyCoats.find((item) => item.id === values.coatId);
    if (!coat) {
      message.warning('请选择挂接的道次');
      return;
    }
    const payload = {
      bodyId,
      coatId: coat.id,
      seq: coat.seq,
      grit: values.grit,
      method: values.method,
      durationMin: values.durationMin,
      operator: values.operator ?? '',
    };
    if (editing) {
      await updatePolish(editing.id, payload);
      message.success('已更新打磨记录');
    } else {
      await createPolish(payload);
      message.success('已新增打磨记录（挂到第 ' + coat.seq + ' 道名下）');
    }
    setOpen(false);
  };

  /** 按道次生成目数序列：为每个尚无打磨记录的道次挂一条建议记录，目数逐道更细 */
  const generateSequence = async (): Promise<void> => {
    const targets = bodyCoats.filter((coat) => !findPolishForCoat(rows, coat));
    if (targets.length === 0) {
      message.info('所有道次均已有打磨记录');
      return;
    }
    for (const coat of targets) {
      await createPolish({
        bodyId,
        coatId: coat.id,
        seq: coat.seq,
        grit: suggestFinerGrit(coat, bodyCoats, rows),
        method: coat.seq >= 3 ? 'burnish' : 'water',
        durationMin: 30 + coat.seq * 5,
        operator: '',
      });
    }
    message.success(`已按 ${targets.length} 个道次生成目数序列（逐道更细，挂到各道名下）`);
  };

  /** 事后补记：给缺少 coatId 的旧记录按序号补道次归属，不回退已罩漆道次 */
  const handleBackfill = async (): Promise<void> => {
    const result = await backfillCoatIds(coats);
    if (result.attached === 0 && result.unclaimed === 0) {
      message.info('没有需要补记归属的打磨记录');
      return;
    }
    message.success(`已补挂 ${result.attached} 条道次归属；${result.unclaimed} 条对不上，已列入待认领`);
  };

  /** 工位认领：把待认领记录挂到所选道次名下 */
  const handleClaim = async (polish: Polish): Promise<void> => {
    const targetCoatId = claimTarget[polish.id];
    if (!targetCoatId) {
      message.warning('请选择要挂到的道次');
      return;
    }
    await claimPolish(polish.id, targetCoatId);
    message.success(`已认领：第 ${bodyCoats.find((c) => c.id === targetCoatId)?.seq ?? ''} 道`);
  };

  /** 对牌文案：本道目数 vs 上一道目数 */
  const gateText = (coat: Coat): string => {
    const gate = evaluateCoatGate(coat, bodyCoats, rows);
    if (!gate.polish) return '未挂打磨记录';
    if (!gate.previousPolish) return `${gate.polish.grit} 目（首道，无上一道可比）`;
    return gate.ok
      ? `${gate.polish.grit} 目 · 比上一道 ${gate.previousPolish.grit} 目更细`
      : `${gate.polish.grit} 目 · 未比上一道 ${gate.previousPolish.grit} 目更细`;
  };

  const columns: ColumnsType<Polish> = [
    {
      title: '挂接道次',
      dataIndex: 'coatId',
      width: 140,
      render: (_value, record) => {
        const coat = bodyCoats.find((item) => item.id === record.coatId);
        return coat ? (
          <StageTag state={coat.state} seq={coat.seq} needRecheck={coat.needRecheck} />
        ) : (
          <Tag color="warning">待认领（原第 {record.seq} 道）</Tag>
        );
      },
    },
    { title: '磨料目数', dataIndex: 'grit', width: 110, render: (value: number) => <Tag color="gold">{value} 目</Tag> },
    {
      title: '手法',
      dataIndex: 'method',
      width: 100,
      render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
    },
    { title: '耗时', dataIndex: 'durationMin', width: 100, render: (value: number) => `${value} 分钟` },
    { title: '操作人', dataIndex: 'operator', width: 110, render: (value: string) => value || '未填写' },
    {
      title: '对牌',
      key: 'gate',
      width: 220,
      render: (_value, record) => {
        const coat = bodyCoats.find((item) => item.id === record.coatId);
        if (!coat) return <Tag color="warning">待认领</Tag>;
        const gate = evaluateCoatGate(coat, bodyCoats, rows);
        return gate.ok ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            {gateText(coat)}
          </Tag>
        ) : (
          <Tooltip title={gate.reason}>
            <Tag icon={<WarningOutlined />} color="error">
              {gateText(coat)}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该打磨记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removePolish(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>打磨与推光工序</h2>
          <p>打磨工位底稿：按道次挂接磨料目数与手法；髹涂工序台推道次前自动对牌，目数逐道更细。</p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button icon={<LinkOutlined />} onClick={() => void handleBackfill()}>
            按序号补记归属
          </Button>
          <Button icon={<ThunderboltOutlined />} onClick={() => void generateSequence()}>
            按道次生成序列
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增打磨记录
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="打磨记录" value={rows.length} suffix="条" tone="primary" />
        <StatBadge label="累计耗时" value={totalMinutes} suffix="分钟" tone="info" />
        <StatBadge label="最高目数" value={maxGrit || '-'} suffix="目" tone="warning" />
        <StatBadge label="道次完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="待打磨停摆" value={stuckCoats.length} suffix="道" tone="danger" />
        <StatBadge label="待认领" value={unclaimed.length} suffix="条" tone="warning" />
      </div>

      {stuckCoats.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`第 ${stuckCoats.map((coat) => coat.seq).join('、')} 道对牌未过，停在待打磨`}
          description="请先补登挂在本道名下的打磨记录（目数需比上一道更细），再到「髹涂道次」台推进；已罩漆的道次不会被退回。"
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 14 }} message="当前胎体道次对牌均已对上，可到髹涂道次台继续推进" />
      )}

      {unclaimed.length > 0 ? (
        <Card
          size="small"
          title={
            <Space>
              <WarningOutlined style={{ color: '#c9963c' }} />
              <span>待认领打磨记录（{unclaimed.length} 条）</span>
            </Space>
          }
          style={{ marginBottom: 14 }}
        >
          <Typography.Text type="secondary">
            这些记录只有胎体编号 + 序号、对不上具体道次（多为旧数据补记产生）。认领后挂到指定道次名下；认领不会回退任何已罩漆道次。
          </Typography.Text>
          <Table<Polish>
            rowKey="id"
            size="small"
            pagination={false}
            style={{ marginTop: 8 }}
            dataSource={unclaimed}
            columns={[
              { title: '原序号', dataIndex: 'seq', width: 90, render: (value: number) => `第 ${value} 道` },
              { title: '磨料目数', dataIndex: 'grit', width: 110, render: (value: number) => <Tag color="gold">{value} 目</Tag> },
              {
                title: '手法',
                dataIndex: 'method',
                width: 100,
                render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
              },
              { title: '操作人', dataIndex: 'operator', width: 110, render: (value: string) => value || '未填写' },
              {
                title: '认领挂到',
                key: 'claim',
                width: 260,
                render: (_value, record) => (
                  <Space size={4}>
                    <Select
                      size="small"
                      style={{ width: 160 }}
                      placeholder="选择道次"
                      value={claimTarget[record.id]}
                      onChange={(value: string) => setClaimTarget((prev) => ({ ...prev, [record.id]: value }))}
                      options={bodyCoats.map((coat) => ({
                        value: coat.id,
                        label: `第 ${coat.seq} 道 · ${COAT_STATE_LABEL[coat.state]}`,
                      }))}
                    />
                    <Button size="small" type="link" onClick={() => void handleClaim(record)}>
                      认领
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {rows.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排道次' : '还没有打磨记录'}
            description={
              bodyCoats.length === 0
                ? '先到「髹涂道次」页编排道次，再按道次生成打磨目数序列。'
                : '可点击「按道次生成序列」按 320→2000 目自动铺排（逐道更细），再逐条补录操作人。'
            }
            actionText="按道次生成序列"
            onAction={() => void generateSequence()}
            secondaryText="新增打磨记录"
            onSecondary={openCreate}
            size="small"
          />
        ) : (
          <Table<Polish> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={rows} />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        标准目数序列：{GRIT_SEQUENCE.join(' → ')} 目（逐道更细）；当前胎体打磨 {rows.length} 条记录。
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑打磨记录（原第 ${editing.seq} 道）` : '新增打磨记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="coatId" label="挂接道次" rules={[{ required: true, message: '请选择挂到哪一道名下' }]}>
            <Select
              options={
                bodyCoats.length > 0
                  ? bodyCoats.map((coat) => ({ value: coat.id, label: `第 ${coat.seq} 道 · ${coat.colorName}` }))
                  : [{ value: '', label: '暂无道次，请先编排' }]
              }
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="grit" label="磨料目数" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={GRIT_SEQUENCE.map((grit) => ({ value: grit, label: `${grit} 目` }))} />
            </Form.Item>
            <Form.Item name="method" label="手法" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...POLISH_METHOD_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="durationMin" label="耗时（分钟）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={600} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="operator" label="操作人" style={{ flex: 1 }}>
              <Input placeholder="如：王丽" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
