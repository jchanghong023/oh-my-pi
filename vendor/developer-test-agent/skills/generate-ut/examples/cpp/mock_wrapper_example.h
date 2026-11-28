/*
 * Description: 虚函数Mock包装层示例
 * 被测代码通过虚接口调用依赖；生产注入适配器，测试注入 Mock。
 */

#ifndef MOCK_WRAPPER_EXAMPLE_H
#define MOCK_WRAPPER_EXAMPLE_H

#include <gmock/gmock.h>
#include <string>
#include <cstdint>

// ============================================================
// 原始类（非虚函数）
// ============================================================

class OriginalService {
public:
    // 非虚函数 - 无法直接Mock
    int32_t ProcessData(const std::string& data);
    int32_t SendRequest(const std::string& endpoint);
    bool IsConnected() const;
};

// ============================================================
// 步骤1：创建虚函数接口类
// ============================================================

class MockServiceInterface {
public:
    virtual ~MockServiceInterface() = default;
    virtual int32_t ProcessData(const std::string& data) = 0;
    virtual int32_t SendRequest(const std::string& endpoint) = 0;
    virtual bool IsConnected() const = 0;
};

// ============================================================
// 步骤2：创建Mock类
// ============================================================

class MockService : public MockServiceInterface {
public:
    MOCK_METHOD(int32_t, ProcessData, (const std::string& data), (override));
    MOCK_METHOD(int32_t, SendRequest, (const std::string& endpoint), (override));
    MOCK_METHOD(bool, IsConnected, (), (const, override));
};

// ============================================================
// 步骤3：创建包装原类的生产适配器
// ============================================================

class ServiceAdapter : public MockServiceInterface {
public:
    explicit ServiceAdapter(OriginalService& service) : service_(service) {}

    int32_t ProcessData(const std::string& data) override {
        return service_.ProcessData(data);
    }

    int32_t SendRequest(const std::string& endpoint) override {
        return service_.SendRequest(endpoint);
    }

    bool IsConnected() const override {
        return service_.IsConnected();
    }

private:
    OriginalService& service_;
};

// ============================================================
// 测试用例中使用示例
// ============================================================

/*
#include "mock_wrapper_example.h"

// 示例被测函数通过虚接口调用依赖。
int32_t ProcessRequest(MockServiceInterface& service) {
    return service.ProcessData("test");
}

class ServiceTest : public ::testing::Test {
protected:
    MockService mockService;
    // 测试直接注入 mockService；生产环境注入 ServiceAdapter。
};

TEST_F(ServiceTest, test_process_when_success_then_return_ok) {
    EXPECT_CALL(mockService, ProcessData("test"))
        .WillOnce(::testing::Return(0));

    int32_t ret = ProcessRequest(mockService);
    EXPECT_EQ(ret, 0);

    ::testing::Mock::VerifyAndClearExpectations(&mockService);
}
*/

#endif // MOCK_WRAPPER_EXAMPLE_H
