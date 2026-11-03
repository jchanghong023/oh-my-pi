/*
 * Description: 完整测试用例示例
 * 包含基本结构、Mock使用、数据清理、断言示例、Fixture状态跟踪、
 * void函数状态验证、EXPECT_DEATH用法、#include .c文件模式、
 * SetUp零重置模式、计算辅助函数模式、#define private public顺序、
 * GIVEN阶段约束、显式NULL指针测试
 */

#include <gtest/gtest.h>
#include <gmock/gmock.h>

#include <cstdint>
#include <cmath>
#include <set>
#include <vector>
#include <cstring>

// C++测C时正确使用extern "C"
extern "C" {
#include "financial_operations.h"
#include "device_manager.h"
#include "protocol_parser.h"
}

using namespace ::testing;

// ============================================================
// 示例1：基本测试结构（纯计算函数）
// ============================================================

class FinancialOperationsTest : public ::testing::Test {
protected:
    void SetUp() override {
        // 通用初始化
    }

    void TearDown() override {
        // 通用清理
    }
};

// 正常路径测试
TEST_F(FinancialOperationsTest, test_calculate_interest_when_valid_input_then_correct_result) {
    double result = calculate_interest(1000.0, 0.05, 1);
    EXPECT_DOUBLE_EQ(result, 50.0);  // 精确结果用EXPECT_DOUBLE_EQ
}

// 边界条件测试
TEST_F(FinancialOperationsTest, test_calculate_interest_when_zero_principal_then_zero_result) {
    double result = calculate_interest(0.0, 0.05, 1);
    EXPECT_DOUBLE_EQ(result, 0.0);
}

// 除零场景测试
TEST_F(FinancialOperationsTest, test_calculate_interest_when_zero_time_then_inf_result) {
    double result = calculate_interest(1000.0, 0.05, 0);
    EXPECT_TRUE(std::isinf(result));  // 除零验证
}

// 浮点除法边界：0.0/负数 = -0.0（不是NaN/Inf）
TEST_F(FinancialOperationsTest, test_divide_when_zero_divided_by_negative_then_negative_zero) {
    double result = divide(0.0, -5.0);
    EXPECT_DOUBLE_EQ(result, -0.0);  // 注意：0.0/负数 = -0.0
    EXPECT_TRUE(std::signbit(result));  // 验证符号位为负
}

// ============================================================
// 示例2：Fixture状态跟踪与TearDown清理
// ============================================================

class DeviceManagerTest : public ::testing::Test {
protected:
    std::set<int> added_device_ids;  // 状态跟踪

    void SetUp() override {
        // 保存全局状态
        saved_device_count = get_device_count();
    }

    void TearDown() override {
        // 系统化清理所有添加的设备
        for (int id : added_device_ids) {
            remove_device(id);
        }
        added_device_ids.clear();
    }

    // 辅助函数：添加设备并跟踪
    int add_tracked_device(const char* name) {
        int id = add_device(name);
        if (id >= 0) {
            added_device_ids.insert(id);
        }
        return id;
    }

    int saved_device_count;
};

TEST_F(DeviceManagerTest, test_add_device_when_valid_name_then_success) {
    int id = add_tracked_device("test_device");
    EXPECT_GE(id, 0);
    EXPECT_EQ(get_device_count(), saved_device_count + 1);  // 验证状态变化
}

// ============================================================
// 示例3：void函数状态验证（不依赖cout输出）
// ============================================================

extern int g_task_count;
extern int g_current_status;

class TaskSchedulerTest : public ::testing::Test {
protected:
    int saved_task_count;
    int saved_status;

    void SetUp() override {
        saved_task_count = g_task_count;
        saved_status = g_current_status;
    }

    void TearDown() override {
        g_task_count = saved_task_count;
        g_current_status = saved_status;
    }
};

// ✅ 正确：验证全局变量状态变化
TEST_F(TaskSchedulerTest, test_schedule_when_task_available_then_count_increased) {
    g_task_count = 0;
    g_current_status = STATUS_IDLE;

    schedule_task();  // void函数

    // 验证状态变化，不依赖cout
    EXPECT_EQ(g_task_count, 1);
    EXPECT_EQ(g_current_status, STATUS_SCHEDULED);
}

// ❌ 错误：仅验证cout输出（不够充分）
// testing::internal::CaptureStdout();
// schedule_task();
// std::string output = testing::internal::GetCapturedStdout();
// EXPECT_NE(output.find("scheduled"), std::string::npos);

// ============================================================
// 示例4：EXPECT_DEATH使用（生产代码有UB/崩溃）
// ============================================================

TEST_F(TaskSchedulerTest, test_schedule_when_empty_list_then_crash) {
    g_task_count = 0;
    // 注意：空任务列表时除零是生产代码bug
    // 使用EXPECT_DEATH验证崩溃行为，保留覆盖率
    EXPECT_DEATH(schedule_task(), ".*");
}

// ============================================================
// 示例5：#include .c文件模式 + SetUp零重置模式（C模块静态状态隔离）
// ============================================================

// 当C模块使用static全局变量且无外部依赖时，
// 直接包含.c文件以访问static变量进行状态重置

// 假设db_operations.c中有：
// static Record database[MAX_RECORDS];
// static int record_count = 0;

/*
#include "db_operations.c"  // 直接包含.c文件

class DbOperationsTest : public ::testing::Test {
protected:
    int saved_record_count;

    void SetUp() override {
        // 1. 保存原始状态
        saved_record_count = record_count;

        // 2. 零重置（确保测试隔离）
        memset(database, 0, sizeof(database));
        record_count = 0;
    }

    void TearDown() override {
        // 恢复原始状态
        record_count = saved_record_count;
    }
};

TEST_F(DbOperationsTest, test_add_record_when_valid_then_count_increased) {
    Record rec = {.id = 1, .data = "test"};
    int ret = add_record(&rec);
    EXPECT_EQ(ret, 0);
    EXPECT_EQ(record_count, 1);  // 直接访问static变量验证
}
*/

// ============================================================
// 示例6：计算辅助函数模式（替代硬编码二进制数据）
// ============================================================

/*
// 假设protocol_parser.h中定义了帧解析函数
// 帧格式：[header 0xAA] [cmd] [payload...] [CRC16] [tail 0x55]

class ProtocolParserTest : public ::testing::Test {
protected:
    // ✅ 计算辅助函数：发现CRC错误时只需修改一处
    uint16_t calculateExpectedCRC(const uint8_t* data, size_t len) {
        uint16_t crc = 0xFFFF;
        for (size_t i = 0; i < len; i++) {
            crc ^= data[i];
            for (int j = 0; j < 8; j++) {
                if (crc & 1) crc = (crc >> 1) ^ 0xA001;
                else crc >>= 1;
            }
        }
        return crc;
    }

    // ✅ 帧构建器：统一构建测试帧
    std::vector<uint8_t> buildTestFrame(uint8_t cmd, const uint8_t* payload, size_t len) {
        std::vector<uint8_t> frame;
        frame.push_back(0xAA);  // header
        frame.push_back(cmd);
        frame.insert(frame.end(), payload, payload + len);
        uint16_t crc = calculateExpectedCRC(frame.data() + 1, frame.size() - 1);
        frame.push_back(crc & 0xFF);
        frame.push_back(crc >> 8);
        frame.push_back(0x55);  // tail
        return frame;
    }
};

TEST_F(ProtocolParserTest, test_parse_when_valid_frame_then_return_payload) {
    uint8_t payload[] = {0x01, 0x02, 0x03};
    auto frame = buildTestFrame(0x10, payload, sizeof(payload));

    parse_result_t result = {};
    int ret = parse_frame(frame.data(), frame.size(), &result);

    EXPECT_EQ(ret, 0);
    EXPECT_EQ(result.cmd, 0x10);
    EXPECT_EQ(result.payload_len, 3);
}

TEST_F(ProtocolParserTest, test_parse_when_crc_error_then_return_error) {
    uint8_t payload[] = {0x01, 0x02, 0x03};
    auto frame = buildTestFrame(0x10, payload, sizeof(payload));
    frame[4] ^= 0xFF;  // 破坏CRC

    parse_result_t result = {};
    int ret = parse_frame(frame.data(), frame.size(), &result);

    EXPECT_EQ(ret, PARSE_ERR_CRC);
}
*/

// ❌ 禁止：硬编码CRC字节数组
// uint8_t frame[] = {0xAA, 0x10, 0x01, 0x02, 0x03, 0x45, 0x67, 0x55};
//                              CRC ^^^^ ^^^^ 如果算法错误，需要逐个用例修改

// ============================================================
// 示例7：#define private public使用顺序
// ============================================================

/*
// ✅ 正确顺序：gtest → 标准库 → #define private public → 被测头文件
#include <gtest/gtest.h>
#include <string>
#include <vector>

#define private public  // 在被测头文件之前定义
#include "secret_class.h"
#undef private  // 可选：恢复private

class SecretClassTest : public ::testing::Test {
protected:
    SecretClass obj;
};

TEST_F(SecretClassTest, test_process_when_internal_state_set_then_correct_result) {
    obj.internal_counter_ = 5;  # 访问private成员
    EXPECT_EQ(obj.process(), 5);
}
*/

// ============================================================
// 示例8：GIVEN阶段约束（增删改查接口）
// ============================================================

/*
// ✅ 正确：使用增接口构造测试数据，再查询验证
TEST_F(DbOperationsTest, test_query_when_record_exists_then_return_data) {
    // GIVEN：使用增接口构造测试数据
    Record rec = {.id = 1, .data = "test"};
    add_record(&rec);

    // WHEN：使用查询接口验证
    Record result = {};
    int ret = query_record(1, &result);

    // THEN：验证查询结果
    EXPECT_EQ(ret, 0);
    EXPECT_STREQ(result.data, "test");
}

// ❌ 错误：Mock查询接口的内部存储
// EXPECT_CALL(mock_storage, find(1))
//     .WillOnce(Return(Pointee(Record{1, "test"})));
// 这验证的是Mock而非真实业务流程
*/

// ============================================================
// 示例9：显式NULL指针测试
// ============================================================

/*
class PointerOpsTest : public ::testing::Test {
protected:
    void SetUp() override {
        // 初始化非空指针
    }
};

// ✅ 正确：显式设置指针为nullptr
TEST_F(PointerOpsTest, test_process_when_null_input_then_return_error) {
    int result = process_data(nullptr);
    EXPECT_EQ(result, ERR_NULL_PTR);
}

// ❌ 错误：依赖隐式初始状态（可能不是nullptr）
// data_t* ptr;  // 未初始化，不保证是nullptr
// int result = process_data(ptr);
*/

// ============================================================
// 示例10：断言耦合最小化
// ============================================================

class ShapeProcessorTest : public ::testing::Test {
protected:
    // ...
};

// ✅ 正确：使用最直接的验证方法
TEST_F(ShapeProcessorTest, test_add_shape_when_valid_then_total_area_updated) {
    ShapeProcessor processor;
    processor.addShape(CIRCLE, 10.0);
    // 直接用calculateTotalArea验证addShape
    EXPECT_DOUBLE_EQ(processor.calculateTotalArea(), 314.1592653589793);
}

// ❌ 错误：使用复杂查询方法间接验证
// auto shapes = processor.getShapesByArea(0, INT_MAX);
// EXPECT_EQ(shapes.size(), 1);

// ============================================================
// 示例11：Mock使用与数据清理
// ============================================================

class MockExternalService {
public:
    virtual ~MockExternalService() = default;
    virtual int fetchData(int id) = 0;
};

class MockService : public MockExternalService {
public:
    MOCK_METHOD(int, fetchData, (int id), (override));
};

class ServiceClientTest : public ::testing::Test {
protected:
    MockService mockService;
    ServiceClient* client;

    void SetUp() override {
        client = new ServiceClient(&mockService);
    }

    void TearDown() override {
        delete client;
    }
};

TEST_F(ServiceClientTest, test_process_when_fetch_success_then_return_data) {
    EXPECT_CALL(mockService, fetchData(100))
        .WillOnce(Return(42));

    int result = client->process(100);
    EXPECT_EQ(result, 42);

    // 在当前用例中清理Mock
    ::testing::Mock::VerifyAndClearExpectations(&mockService);
}

TEST_F(ServiceClientTest, test_process_when_fetch_fails_then_return_error) {
    EXPECT_CALL(mockService, fetchData(100))
        .WillOnce(Return(-1));

    int result = client->process(100);
    EXPECT_EQ(result, -1);

    ::testing::Mock::VerifyAndClearExpectations(&mockService);
}

// ============================================================
// 示例12：测试命名准确性（void函数不崩溃测试）
// ============================================================

// ✅ 正确：仅验证不崩溃时使用_NoThrow后缀
// TEST_F(SomeTest, test_init_when_invalid_config_then_NoThrow) {
//     EXPECT_NO_THROW(init(invalid_config));
// }

// ❌ 错误：使用暗示行为验证的名称但实际只验证不崩溃
// TEST_F(SomeTest, test_init_when_invalid_config_then_Configured) {
//     EXPECT_NO_THROW(init(invalid_config));
//     // 名称暗示"已配置"，但实际只验证了不崩溃
// }
