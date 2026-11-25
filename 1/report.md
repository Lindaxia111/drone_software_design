# 实验报告：抗风悬停 · 长航时四旋翼

- run_id：`e001e9821607`　状态：**BUDGET_EXHAUSTED**　耗时：17.0s
- 预算使用：{'L1': 80, 'L2': 80, 'L3': 0}　缓存命中：{'L1': 0, 'L2': 0, 'L3': 0}

## 仿真漏斗

| 层级 | 进入 | 通过 | 淘汰率 |
|---|---|---|---|
| L1 静态解析 | 80 | 42 | 48% |
| L2 轻量动力学 | 40 | 40 | 0% |

## 收敛曲线（历史最优适应度）

| 代 | 本代最优 | 历史最优 | L1执行 | L2晋级 | 缓存命中 |
|---|---|---|---|---|---|
| 0 | 18.893 | 18.893 | 16 | 5 | 0 |
| 1 | 21.310 | 21.310 | 16 | 8 | 0 |
| 2 | 21.342 | 21.342 | 16 | 7 | 0 |
| 3 | 23.602 | 23.602 | 16 | 10 | 0 |
| 4 | 24.027 | 24.027 | 16 | 10 | 0 |

## 最优构型

- ir_hash：`72ec194803eeeb50…`　验证层级：L2　适应度：24.027
- 谱系深度：2

| 指标 | 值 |
|---|---|
| allocation_cond | 1 |
| cg_offset_m | 2.502e-17 |
| crash_rate | 0 |
| discharge_margin | 1.158 |
| energy_wh | 0.6069 |
| final_pos_err_m | 0.08346 |
| flight_time_min | 29.67 |
| flight_time_min_sim | 29.72 |
| hover_power_w | 242.6 |
| hover_throttle | 0.3758 |
| max_pos_err_m | 0.5352 |
| max_pos_err_m_worst | 0.5887 |
| max_rotor_util | 0.396 |
| max_tilt_deg | 19.98 |
| max_tilt_deg_worst | 10.58 |
| mean_power_w | 242.6 |
| min_rotor_clearance_m | 0.1433 |
| peak_power_w | 1036 |
| rotor_count | 4 |
| saturation_frac | 0 |
| thrust_to_weight_ratio | 2.661 |
| total_mass_kg | 2.233 |
| tracking_rmse_m | 0.2823 |
| tracking_rmse_m_worst | 0.2704 |

关键设计参数：
- 旋翼数 4，臂长 0.313 m，单桨最大推力 14.57 N，桨半径 0.149 m
- 电池 150.0 Wh / 0.833 kg，机体 1.20 kg，载荷 0.20 kg

## 帕累托前沿

| ir_hash | flight_time_min | tracking_rmse_m |
|---|---|---|
| `72ec194803` | 29.67 | 0.2823 |
