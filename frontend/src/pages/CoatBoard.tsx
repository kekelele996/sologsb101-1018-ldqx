/**
 * /coats 髹涂道次编排
 * 拖拽调整道次先后、批量改漆种与状态、同器型自动带出上次漆种与间隔建议。
 * 消费 Coat、Body；复用 <StageTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
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
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { usePolishStore } from '@/stores/polishStore';
import {
  COAT_STATE_LABEL,
  COAT_STATE_OPTIONS,
  COLOR_NAME_OPTIONS,
  PAINT_TYPE_LABEL,
  PAINT_TYPE_OPTIONS,
  createEmptyCoatDraft,
  type Coat,
  type CoatDraft,
  type CoatState,
  type PaintType,
} from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { suggestIntervalHours } from '@/utils/humidity';

/** 取某道次名下挂名的打磨记录里最细的目数（只读打磨底稿） */
function linkedGritOf(polishGritRows: { coatSeq: number | null; claimState: string; grit: number }[], coatSeq: number): number | null {
  const grits = polishGritRows
    .filter((row) => row.claimState === 'linked' && row.coatSeq === coatSeq)
    .map((row) => row.grit);
  return grits.length === 0 ? null : Math.max(...grits);
}

const FILTER_KEYS = ['paintType', 'state'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'paintType', label: '漆种', options: PAINT_TYPE_OPTIONS },
  { key: 'state', label: '状态', options: COAT_STATE_OPTIONS },
];

export default function CoatBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CoatDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const createCoat = useCoatStore((state) => state.createCoat);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const removeCoat = useCoatStore((state) => state.removeCoat);
  const batchUpdate = useCoatStore((state) => state.batchUpdate);
  const advanceState = useCoatStore((state) => state.advanceState);
  const reorderCoats = useCoatStore((state) => state.reorderCoats);
  const nextSeq = useCoatStore((state) => state.nextSeq);
  const suggestForBody = useCoatStore((state) => state.suggestForBody);
  const polishes = usePolishStore((state) => state.polishes);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const url = useFilterQuery(FILTER_KEYS);

  const [editing, setEditing] = useState<Coat | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPaint, setBatchPaint] = useState<PaintType>('color');
  const [batchState, setBatchState] = useState<CoatState>('coated');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  useEffect(() => {
    if (!currentBodyId && bodies.length > 0) setCurrentBodyId(bodies[0]!.id);
  }, [bodies, currentBodyId, setCurrentBodyId]);

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  /** 打磨工位挂在本胎体各道次名下的记录（只读，不回写打磨底稿） */
  const bodyPolishRows = useMemo(
    () => polishes.filter((item) => item.bodyId === bodyId),
    [polishes, bodyId],
  );

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const paintTypes = url.values.paintType ?? [];
    const states = url.values.state ?? [];
    return bodyCoats.filter((coat) => {
      if (keyword.length > 0) {
        const haystack = `${coat.colorName}${coat.coatDate}${coat.thicknessUm}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (paintTypes.length > 0 && !paintTypes.includes(coat.paintType)) return false;
      if (states.length > 0 && !states.includes(coat.state)) return false;
      return true;
    });
  }, [bodyCoats, url.keyword, url.values]);

  const suggestion = bodyId.length > 0 ? suggestForBody(bodyId) : null;
  const stat = bodyId.length > 0 ? progressOf(bodyId) : null;

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择或新建胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyCoatDraft(bodyId, nextSeq(bodyId)),
      paintType: suggestion?.paintType ?? 'raw',
    });
    setOpen(true);
  };

  const openEdit = (coat: Coat): void => {
    setEditing(coat);
    form.setFieldsValue({
      bodyId: coat.bodyId,
      seq: coat.seq,
      paintType: coat.paintType,
      colorName: coat.colorName,
      coatDate: coat.coatDate,
      thicknessUm: coat.thicknessUm,
      state: coat.state,
      needRecheck: coat.needRecheck,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const payload: CoatDraft = { ...values };
    if (editing) {
      await updateCoat(editing.id, payload);
      message.success(`已更新第 ${payload.seq} 道工序`);
    } else {
      await createCoat(payload);
      message.success(`已新增第 ${payload.seq} 道工序`);
    }
    setOpen(false);
  };

  /** 拖拽重排：按落点重排并落库重编号 */
  const handleDrop = async (targetId: string): Promise<void> => {
    setOverId(null);
    if (!dragId || dragId === targetId || !bodyId) {
      setDragId(null);
      return;
    }
    const ids = bodyCoats.map((coat) => coat.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    await reorderCoats(bodyId, ids);
    setDragId(null);
    message.success('道次顺序已更新并重编号');
  };

  /** 状态推进：前一道未完成禁止进入下一道；推出待打磨前由 store 对挂名打磨与目数 */
  const handleAdvance = async (coat: Coat): Promise<void> => {
    const previous = bodyCoats.find((item) => item.seq === coat.seq - 1);
    if (previous && previous.state !== 'done') {
      message.warning(`第 ${previous.seq} 道尚未完成，禁止进入第 ${coat.seq} 道`);
      return;
    }
    const outcome = await advanceState(coat.id);
    if (outcome.moved) {
      message.success(outcome.message);
    } else {
      message.warning(outcome.message);
    }
  };

  const columns: ColumnsType<Coat> = [
    {
      title: '',
      dataIndex: 'drag',
      width: 44,
      render: (_value, record) => (
        <Tooltip title="按住拖动可调整道次先后">
          <span
            className="gb-drag-handle"
            draggable
            onDragStart={() => setDragId(record.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <HolderOutlined />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '道次',
      dataIndex: 'seq',
      width: 90,
      sorter: (a, b) => a.seq - b.seq,
      render: (seq: number, record) => (
        <StageTag state={record.state} seq={seq} needRecheck={record.needRecheck} />
      ),
    },
    { title: '漆种', dataIndex: 'paintType', width: 100, render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag> },
    { title: '色名', dataIndex: 'colorName', width: 120 },
    { title: '涂刷日期', dataIndex: 'coatDate', width: 130, sorter: (a, b) => a.coatDate.localeCompare(b.coatDate) },
    {
      title: '湿膜厚度',
      dataIndex: 'thicknessUm',
      width: 120,
      render: (value: number) => `${value} μm`,
    },
    {
      title: '挂名打磨目数',
      key: 'polishGrit',
      width: 130,
      render: (_value, record) => {
        const grit = linkedGritOf(bodyPolishRows, record.seq);
        if (grit === null) {
          return record.state === 'toPolish' ? (
            <Tooltip title="该道名下没有挂名打磨记录，推道次会停在待打磨">
              <Tag color="red">无挂名</Tag>
            </Tooltip>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          );
        }
        const prevGrit = linkedGritOf(bodyPolishRows, record.seq - 1);
        const finer = prevGrit === null || grit > prevGrit;
        return (
          <Tooltip title={prevGrit === null ? '无上一道可比对' : `上一道挂名 ${prevGrit} 目`}>
            <Tag color={finer ? 'gold' : 'red'}>
              {grit} 目{prevGrit !== null ? (finer ? ' ✓' : ' 不够细') : ''}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => void handleAdvance(record)}>
            推进状态
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该道次"
            description="删除后其余道次会自动重编号。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
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
          <h2>髹涂道次编排</h2>
          <p>逐道登记漆种与色名，拖拽调整先后顺序；批量改漆种或状态，同器型自动带出上次做法。</p>
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增道次
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="道次总数" value={stat?.coatTotal ?? 0} suffix="道" tone="primary" />
        <StatBadge label="完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="当前道次" value={stat?.currentSeq ? `第 ${stat.currentSeq} 道` : '已完工'} tone="warning" />
        <StatBadge label="全局待复检" value={totals.recheck} suffix="道" tone="danger" />
        <StatBadge label="荫干等待" value={stat?.dryingHours ?? 0} suffix="小时" tone="info" />
      </div>

      {suggestion && suggestion.sourceCode ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`同器型参考：${suggestion.sourceCode} 上次采用${suggestion.sourceColor || '同漆种'}，建议下一道用「${
            PAINT_TYPE_LABEL[suggestion.paintType]
          }」，间隔约 ${suggestion.intervalHours} 小时`}
          action={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                form.setFieldsValue({ paintType: suggestion.paintType });
                message.success('已带出建议漆种');
              }}
            >
              带出建议
            </Button>
          }
        />
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索色名 / 日期 / 厚度…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchPaint}
              options={[...PAINT_TYPE_OPTIONS]}
              onChange={(value: PaintType) => setBatchPaint(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { paintType: batchPaint }).then(() => {
                  message.success(`已批量改为${PAINT_TYPE_LABEL[batchPaint]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改漆种
            </Button>            <Select
              size="small"
              style={{ width: 120 }}
              value={batchState}
              options={[...COAT_STATE_OPTIONS]}
              onChange={(value: CoatState) => setBatchState(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { state: batchState }).then((stat) => {
                  if (stat.blocked > 0) {
                    message.warning(`已更新 ${stat.updated} 道；${stat.blocked} 道停在待打磨：${stat.blockedMessages.join('；')}`);
                  } else {
                    message.success(`已批量改为${COAT_STATE_LABEL[batchState]}（${stat.updated} 道）`);
                  }
                  setSelectedIds([]);
                })
              }
            >
              批量改状态
            </Button>
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排髹涂道次' : '当前筛选条件下没有道次'}
            description={
              bodyCoats.length === 0
                ? '从第一道生漆打底开始，逐道登记漆种、色名与湿膜厚度。'
                : '试着调整漆种或状态筛选条件。'
            }
            actionText="新增道次"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={url.reset}
            size="small"
          />
        ) : (
          <Table<Coat>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={filtered}
            onRow={(record) => ({
              onDragOver: (event) => {
                event.preventDefault();
                setOverId(record.id);
              },
              onDrop: () => void handleDrop(record.id),
              className: overId === record.id && dragId !== record.id ? 'gb-row-drop-target' : undefined,
            })}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            rowClassName={(record) => (record.id === dragId ? 'gb-row-dragging' : '')}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        当前胎体进度：{bodyId ? currentCoatText(bodyId) : '未选择胎体'}
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.seq} 道` : '新增髹涂道次'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="seq" label="道次序号" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="colorName" label="色名" rules={[{ required: true, message: '请填写色名' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                options={COLOR_NAME_OPTIONS.map((name) => ({ value: name, label: name }))}
                placeholder="如：朱红"
              />
            </Form.Item>
            <Form.Item name="coatDate" label="涂刷日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="thicknessUm" label="湿膜厚度（μm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={500} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...COAT_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="needRecheck" label="待复检">
            <Select
              options={[
                { value: false, label: '正常' },
                { value: true, label: '待复检（荫房异常）' },
              ]}
            />
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            message={`环境适宜时，${PAINT_TYPE_LABEL[form.getFieldValue('paintType') as PaintType] ?? '该漆种'}建议间隔约 ${
              suggestion?.intervalHours ?? suggestIntervalHours('raw')
            } 小时再进入下一道`}
          />
        </Form>
      </Modal>
    </div>
  );
}
