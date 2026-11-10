import { prisma } from '../../config/prisma';
import { Role } from '@prisma/client';
import { revokeAllForUser } from './session.store';

const userInclude = {
  business: {
    include: {
      subscription: true,
    },
  },
  businessOwner: true,
} as const;

export class AuthRepository {

  async registerOwner(data: {
    user: {
      name: string;
      email: string;
      passwordHash: string;
      phoneNo: string;
    };

    business: {
      name: string;
      locationsCount: string;
      businessType: string;
      contactDetail: string;
    };
  }) {

    return prisma.$transaction(async (tx) => {

      // 1. Create Business
      const business = await tx.business.create({
        data: {
          name: data.business.name,
          locationsCount: data.business.locationsCount,
          businessType: data.business.businessType,
          contactDetail: data.business.contactDetail,
        },
      });

      // 2. Create User
      const user = await tx.user.create({
        data: {
          businessId: business.id,
          name: data.user.name,
          email: data.user.email,
          passwordHash: data.user.passwordHash,
          phoneNo: data.user.phoneNo,
          role: Role.BUSINESS_OWNER,
        },
      });

      // 3. Create BusinessOwner link
      const businessOwner = await tx.businessOwner.create({
        data: {
          userId: user.id,
          businessId: business.id,
        },
      });

      return {
        business,
        user,
        businessOwner,
      };
    });

  }

  async registerSupplier(data: {
    user: {
      name: string;
      email: string;
      passwordHash: string;
      phoneNo: string;
    };
    supplier: {
      name: string;
      contactPerson: string;
      address: string;
      category?: string;
      gstNumber?: string;
      deliveryTerms?: string;
    };
  }) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.user.name,
          email: data.user.email,
          passwordHash: data.user.passwordHash,
          phoneNo: data.user.phoneNo,
          role: Role.SUPPLIER,
        },
      });

      const supplier = await tx.supplier.create({
        data: {
          name: data.supplier.name,
          contactPerson: data.supplier.contactPerson,
          phone: data.user.phoneNo,
          email: data.user.email,
          address: data.supplier.address,
          category: data.supplier.category,
          gstNumber: data.supplier.gstNumber,
          deliveryTerms: data.supplier.deliveryTerms,
          type: 'ONLINE',
          userId: user.id,
        },
      });

      return { user, supplier };
    });
  }

  /**
   * Case-insensitive, so accounts created before emails were normalised (e.g. "Owner@Cafe.com")
   * can still sign in and reset their password. The oldest matching account wins.
   */
  async findUserByEmail(email: string) {
    return prisma.user.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      include: userInclude,
    });
  }

  async findUserById(id: string) {
    return prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: userInclude,
    });
  }

  async findSupplierByUserId(userId: string) {
    return prisma.supplier.findFirst({
      where: {
        userId,
        deletedAt: null,
      },
    });
  }

  /** Ends every login of this user (all devices). */
  async deleteUserRefreshTokens(userId: string) {
    await revokeAllForUser(userId);
  }

  async updateUser(userId: string, data: { name?: string; phoneNo?: string }) {
    return prisma.user.update({
      where: { id: userId },
      data,
      include: userInclude,
    });
  }

  async updatePassword(userId: string, passwordHash: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }
}
