/*
 * Description: 虚函数Mock包装层示例
 * 当被测代码依赖非虚函数时，需要创建Mock包装层
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
// 步骤3：创建适配器
// ============================================================

class ServiceAdapter : public OriginalService {
public:
    explicit ServiceAdapter(MockServiceInterface* mock) : mock_(mock) {}

    int32_t ProcessData(const std::string& data) override {
        return mock_->ProcessData(data);
    }

    int32_t SendRequest(const std::string& endpoint) override {
        return mock_->SendRequest(endpoint);
    }

    bool IsConnected() const override {
        return mock_->IsConnected();
    }

private:
    MockServiceInterface* mock_;
};

// ============================================================
// 测试用例中使用示例
// ============================================================

/*
#include "mock/mock_service.h"

class ServiceTest : public ::testing::Test {
protected:
    MockService mockService;
    ServiceAdapter adapter{&mockService};
};

TEST_F(ServiceTest, test_process_when_success_then_return_ok) {
    EXPECT_CALL(mockService, ProcessData(_))
        .WillOnce(Return(0));

    int32_t ret = adapter.ProcessData("test");
    EXPECT_EQ(ret, 0);

    ::testing::Mock::VerifyAndClearExpectations(&mockService);
}
*/

#endif // MOCK_WRAPPER_EXAMPLE_H
