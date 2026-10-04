/**
 * /polish 打磨工位（打磨推光记录与磨料目数底稿）
 * 只管自己的 polishes 底稿；读道次仅为显示与判定挂名，绝不回写 coats。
 * - 记录可挂在「待打磨」道次名下；已罩漆（已完成）道次不退回补挂；
 * - 补不上道次的记录由工位单列「待认领」；
 * - 能不能推出待打磨由髹涂工序台对挂名记录与目数（比上一道更细）核验。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { usePolishStore } from '@/stores/polishStore';
import {
  GRIT_SEQUENCE,
  POLISH_METHOD_COLOR,
  POLISH_METHOD_LABEL,
  POLISH_METHOD_OPTIONS,
  POLISH_SOURCE_LABEL,
  createEmptyPolishDraft,
  type Polish,
  type PolishDraft,
  type PolishMethod,
} from '@/types/polish';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL } from '@/types/coat';

/** 表单里「暂不挂名（待认领）」的选项值 */
const NO_COAT_VALUE = -1;
/** 可选目数：标准序列之外留出精抛目数 */
const GRIT_OPTIONS: readonly number[] = [...GRIT_SEQUENCE, 2500, 3000];

export default function PolishBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PolishDraft & { late?: boolean }>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const polishes = usePolishStore((state) => state.polishes);
  const createPolish = usePolishStore((state) => state.createPolish);
  const updatePolish = usePolishStore((state) => state.updatePolish);
  const removePolish = usePolishStore((state) => state.removePolish);
  const claimPolish = usePolishStore((state) => state.claimPolish);
  const generateForBody = usePolishStore((state) => state.generateForBody);
  const { progressOf } = useCoatProgress();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Polish | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  /** 当前胎体的打磨底稿，按工位序号排列 */
  const rows = useMemo(
    () =>
      polishes
        .filter((row) => row.bodyId === bodyId)
        .sort((a, b) => (a.coatSeq === b.coatSeq ? a.grit - b.grit : a.seq - b.seq)),
    [polishes, bodyId],
  );

  /** 工位单列：全部胎体里补不上道次的记录 */
  const unclaimedRows = useMemo(
    () => polishes.filter((row) => row.claimState === 'unclaimed').sort((a, b) => a.updatedAt - b.updatedAt),
    [polishes],
  );
  const bodyUnclaimed = useMemo(
    () => unclaimedRows.filter((row) => row.bodyId === bodyId),
    [unclaimedRows, bodyId],
  );

  /** 髹涂台视角：处于待打磨但名下没有挂名记录的道次（推不出去） */
  const blocked = useMemo(
    () =>
      bodyCoats.filter(
        (coat) =>
          coat.state === 'toPolish' &&
          !polishes.some((row) => row.bodyId === bodyId && row.claimState === 'linked' && row.coatSeq === coat.seq),
      ),
    [bodyCoats, polishes, bodyId],
  );

  const stat = bodyId ? progressOf(bodyId) : null;
  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMin, 0);
  const maxGrit = rows.reduce((max, row) => Math.max(max, row.grit), 0);

  const coatOf = (bId: string, coatSeq: number | null) =>
    coatSeq === null ? undefined : coats.find((coat) => coat.bodyId === bId && coat.seq === coatSeq);

  /**
   * 挂名道次选项：只允许挂到「待打磨」道次。
   * 编辑时当前已挂的道次保留（可能已被髹涂台推进为已完成），其它非待打磨道次禁用，
   * 避免误把记录挂到已罩漆道次上。
   */
  const coatOptions = useMemo(() => {
    const options = bodyCoats.map((coat) => {
      const isCurrent = editing?.coatSeq === coat.seq;
      const selectable = coat.state === 'toPolish' || isCurrent;
      return {
        value: coat.seq,
        label: `第 ${coat.seq} 道 · ${coat.colorName}（${COAT_STATE_LABEL[coat.state]}${isCurrent ? '·当前挂名' : ''}）`,
        disabled: !selectable,
      };
    });
    return [{ value: NO_COAT_VALUE, label: '暂不挂名（列为待认领）' }, ...options];
  }, [bodyCoats, editing]);

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择胎体');
      return;
    }
    const firstWaiting = bodyCoats.find((coat) => coat.state === 'toPolish');
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyPolishDraft(bodyId, firstWaiting?.seq ?? null),
      late: false,
    });
    setOpen(true);
  };

  const openEdit = (row: Polish): void => {
    setEditing(row);
    form.setFieldsValue({
      bodyId: row.bodyId,
      coatSeq: row.coatSeq,
      grit: row.grit,
      method: row.method,
      durationMin: row.durationMin,
      operator: row.operator,
      source: row.source,
      claimState: row.claimState,
      late: row.source === 'late',
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const { late, ...rest } = values;
    const payload: PolishDraft = {
      ...rest,
      coatSeq: rest.coatSeq === NO_COAT_VALUE ? null : rest.coatSeq,
      source: late ? 'late' : 'regular',
    };
    if (editing) {
      await updatePolish(editing.id, payload);
      message.success('已更新打磨底稿');
    } else {
      const created = await createPolish(payload);
      message.success(created.claimState === 'linked' ? '打磨记录已挂名道次' : '已登记，该记录列入待认领');
    }
    setOpen(false);
  };

  /** 按道次铺排：只为「待打磨且尚无挂名记录」的道次生成，其他跳过 */
  const generateSequence = async (): Promise<void> => {
    if (!bodyId) return;
    const { created, skipped } = await generateForBody(bodyId);
    if (created === 0) {
      message.info(skipped > 0 ? '待打磨道次均已有挂名记录' : '当前没有待打磨的道次可挂名');
      return;
    }
    message.success(`已为 ${created} 个待打磨道次挂名铺排目数${skipped > 0 ? `，跳过 ${skipped} 道已有记录` : ''}`);
  };

  /** 待认领记录挂到某待打磨道次名下：只改打磨底稿，不触碰道次 */
  const claim = (row: Polish, coatSeq: number): void => {
    void claimPolish(row.id, coatSeq)
      .then(() => message.success(`已挂到第 ${coatSeq} 道名下`))
      .catch((error: unknown) => message.error(error instanceof Error ? error.message : '认领失败'));
  };

  const linkedColumns: ColumnsType<Polish> = [
    {
      title: '挂名道次',
      dataIndex: 'coatSeq',
      width: 150,
      render: (coatSeq: number | null) => {
        const coat = coatOf(bodyId, coatSeq);
        return coat ? (
          <StageTag state={coat.state} seq={coat.seq} needRecheck={coat.needRecheck} />
        ) : (
          <Tag>未挂名（待认领）</Tag>
        );
      },
    },
    { title: '磨料目数', dataIndex: 'grit', width: 110, render: (value: number) => <Tag color="gold">{value} 目</Tag> },
    {
      title: '手法',
      dataIndex: 'method',
      width: 90,
      render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
    },
    { title: '耗时', dataIndex: 'durationMin', width: 90, render: (value: number) => `${value} 分钟` },
    { title: '操作人', dataIndex: 'operator', width: 100, render: (value: string) => value || '未填写' },
    {
      title: '来源 / 挂名',
      dataIndex: 'source',
      width: 120,
      render: (value: Polish['source'], record) => (
        <Space size={4} wrap>
          {value === 'late' ? (
            <Tag color="orange">{POLISH_SOURCE_LABEL.late}</Tag>
          ) : (
            <Tag>{POLISH_SOURCE_LABEL.regular}</Tag>
          )}
          {record.claimState === 'unclaimed' && <Tag color="red">待认领</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该打磨记录"
            description="只删打磨底稿，不改动任何道次状态。"
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

  /** 待认领导出（跨胎体） */
  const unclaimedColumns: ColumnsType<Polish> = [
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 130,
      render: (value: string) => bodies.find((body) => body.id === value)?.code ?? value,
    },
    {
      title: '拟挂道次',
      dataIndex: 'coatSeq',
      width: 120,
      render: (coatSeq: number | null, record) => {
        if (coatSeq === null) return <Tag>未指明</Tag>;
        const coat = coatOf(record.bodyId, coatSeq);
        return coat ? (
          <StageTag state={coat.state} seq={coat.seq} needRecheck={coat.needRecheck} />
        ) : (
          <Tag color="red">第 {coatSeq} 道（不存在）</Tag>
        );
      },
    },
    { title: '目数', dataIndex: 'grit', width: 90, render: (value: number) => <Tag color="gold">{value} 目</Tag> },
    {
      title: '手法',
      dataIndex: 'method',
      width: 90,
      render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
    },
    { title: '操作人', dataIndex: 'operator', width: 90, render: (value: string) => value || '未填写' },
    {
      title: '认领到待打磨道次',
      key: 'claim',
      render: (_value, record) => {
        const waitingCoats = coats
          .filter((coat) => coat.bodyId === record.bodyId && coat.state === 'toPolish')
          .sort((a, b) => a.seq - b.seq);
        return waitingCoats.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            该胎体没有待打磨道次，无法认领
          </Typography.Text>
        ) : (
          <Select
            size="small"
            style={{ minWidth: 200 }}
            placeholder="选择待打磨道次挂名"
            options={waitingCoats.map((coat) => ({
              value: coat.seq,
              label: `第 ${coat.seq} 道 · ${coat.colorName}`,
            }))}
            onChange={(value: number) => claim(record, value)}
          />
        );
      },
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>打磨与推光工序（打磨工位底稿）</h2>
          <p>只管打磨推光记录与磨料目数；挂名到待打磨道次。已罩漆的道次不退回，补不上的单列待认领。</p>
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
          <Button icon={<ThunderboltOutlined />} onClick={() => void generateSequence()}>
            按待打磨道次挂名
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增打磨记录
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="本胎体记录" value={rows.length} suffix="条" tone="primary" />
        <StatBadge label="累计耗时" value={totalMinutes} suffix="分钟" tone="info" />
        <StatBadge label="最高目数" value={maxGrit || '-'} suffix="目" tone="warning" />
        <StatBadge label="道次完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="待打磨未挂名" value={blocked.length} suffix="道" tone="danger" />
        <StatBadge label="待认领" value={unclaimedRows.length} suffix="条" tone="danger" />
      </div>

      {blocked.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`第 ${blocked.map((coat) => coat.seq).join('、')} 道处于待打磨且名下无挂名记录`}
          description="髹涂工序台推道次时会对挂名打磨记录并要求目数比上一道更细；请先挂名，否则道次停在待打磨。"
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 14 }} message="当前胎体待打磨道次均已挂名，能否罩漆由髹涂工序台核验目数" />
      )}

      <Card
        className="gb-table-card"
        title="打磨推光记录（按工位序号）"
        styles={{ body: { padding: 0 } }}
      >
        {rows.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排道次' : '还没有打磨记录'}
            description={
              bodyCoats.length === 0
                ? '先到「髹涂道次」页编排道次；待道次进入待打磨后再挂名登记。'
                : '可点击「按待打磨道次挂名」自动铺排目数，或手动新增（含事后补记）。'
            }
            actionText="按待打磨道次挂名"
            onAction={() => void generateSequence()}
            secondaryText="新增打磨记录"
            onSecondary={openCreate}
            size="small"
          />
        ) : (
          <Table<Polish> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={linkedColumns} dataSource={rows} />
        )}
      </Card>

      <Card
        className="gb-table-card"
        style={{ marginTop: 16 }}
        title={
          <Space>
            <LinkOutlined />
            <span>待认领（工位单列 · 全部胎体）</span>
            <Tag color="red">{unclaimedRows.length}</Tag>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        {unclaimedRows.length === 0 ? (
          <Typography.Text type="secondary" style={{ display: 'block', padding: 16 }}>
            没有补不上道次的打磨记录。
          </Typography.Text>
        ) : (
          <Table<Polish>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5 }}
            columns={unclaimedColumns}
            dataSource={unclaimedRows}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        标准目数序列：{GRIT_SEQUENCE.join(' → ')} 目（数字越大越细）；本胎体 {rows.length} 条、待认领 {bodyUnclaimed.length} 条。
        打磨工位不回写道次，已罩漆道次不会因补记退回。
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑打磨记录（工位序号 ${editing.seq}）` : '新增打磨记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="coatSeq" label="挂名道次" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={coatOptions} />
            </Form.Item>
            <Form.Item name="grit" label="磨料目数（需比上一道更细）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={GRIT_OPTIONS.map((grit) => ({ value: grit, label: `${grit} 目` }))}
              />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="method" label="手法" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...POLISH_METHOD_OPTIONS]} />
            </Form.Item>
            <Form.Item name="durationMin" label="耗时（分钟）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="操作人">
            <Input placeholder="如：王丽" />
          </Form.Item>
          <Form.Item name="late" valuePropName="checked" tooltip="事后补记时，已罩漆的道次不会退回；补不上则列为待认领">
            <Checkbox>事后补记（工位补录，可能已罩漆）</Checkbox>
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="只有处于「待打磨」的道次接收挂名；已完成（已罩漆）的道次不退回，记录将进入下方待认领。"
          />
        </Form>
      </Modal>
    </div>
  );
}
