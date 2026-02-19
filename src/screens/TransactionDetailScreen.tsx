import React, { useState } from "react";
import {
	View,
	Text,
	StyleSheet,
	TouchableOpacity,
	ScrollView,
	Alert,
	Image,
	Modal,
	Dimensions,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { deleteTransaction } from "../database/transactionService";
import { theme } from "../theme";

const screenWidth = Dimensions.get("window").width;

export default function TransactionDetailsScreen() {
	const route: any = useRoute();
	const navigation: any = useNavigation();

	const transaction = route.params?.transaction;

	const [previewImage, setPreviewImage] = useState<string | null>(null);

	if (!transaction) {
		return (
			<View style={styles.container}>
				<Text>No Transaction Found</Text>
			</View>
		);
	}

	const images: string[] = transaction.imagePath
		? JSON.parse(transaction.imagePath)
		: [];

	const handleDelete = () => {
		Alert.alert(
			"Delete Transaction",
			"Are you sure you want to delete this transaction?",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Delete",
					style: "destructive",
					onPress: async () => {
						await deleteTransaction(transaction.id);
						navigation.goBack();
					},
				},
			],
		);
	};

	const handleEdit = () => {
		navigation.navigate("AddEntry", {
			transaction,
		});
	};

	return (
		<View style={styles.container}>
			<ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
				{/* HEADER */}
				<View style={styles.header}>
					<Text
						style={[
							styles.amount,
							{
								color:
									transaction.type === "income"
										? theme.colors.income
										: theme.colors.expense,
							},
						]}
					>
						₹{transaction.amount}
					</Text>

					<Text style={styles.typeText}>{transaction.type.toUpperCase()}</Text>
				</View>

				{/* INFO SECTION */}
				<View style={styles.card}>
					<InfoRow label="Category" value={transaction.category} />
					<InfoRow label="Supplier" value={transaction.supplierName || "-"} />
					<InfoRow label="Payment" value={transaction.paymentType} />
					<InfoRow label="Date" value={transaction.date} />
					<InfoRow label="Note" value={transaction.note || "-"} />
				</View>

				{/* IMAGE GRID */}
				{images.length > 0 && (
					<View style={{ marginTop: 20 }}>
						<Text style={styles.sectionTitle}>Bill Images</Text>

						<View style={styles.grid}>
							{images.map((img, index) => (
								<TouchableOpacity
									key={index}
									style={styles.imageBox}
									onPress={() => setPreviewImage(img)}
								>
									<Image source={{ uri: img }} style={styles.previewImage} />
								</TouchableOpacity>
							))}
						</View>
					</View>
				)}
			</ScrollView>

			{/* ACTION BUTTONS */}
			<View style={styles.buttonRow}>
				<TouchableOpacity style={styles.editButton} onPress={handleEdit}>
					<Ionicons name="create-outline" size={18} color="#fff" />
					<Text style={styles.buttonText}>Edit</Text>
				</TouchableOpacity>

				<TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
					<Ionicons name="trash-outline" size={18} color="#fff" />
					<Text style={styles.buttonText}>Delete</Text>
				</TouchableOpacity>
			</View>

			{/* FULLSCREEN IMAGE PREVIEW */}
			<Modal visible={!!previewImage} transparent>
				<View style={styles.modalContainer}>
					<TouchableOpacity
						style={styles.closeButton}
						onPress={() => setPreviewImage(null)}
					>
						<Ionicons name="close" size={28} color="#fff" />
					</TouchableOpacity>

					{previewImage && (
						<Image
							source={{ uri: previewImage }}
							style={styles.fullImage}
							resizeMode="contain"
						/>
					)}
				</View>
			</Modal>
		</View>
	);
}

function InfoRow({ label, value }: any) {
	return (
		<View style={styles.infoRow}>
			<Text style={styles.label}>{label}</Text>
			<Text style={styles.value}>{value}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	header: {
		alignItems: "center",
		marginBottom: 20,
	},

	amount: {
		fontSize: 32,
		fontWeight: "700",
	},

	typeText: {
		marginTop: 6,
		fontWeight: "600",
		opacity: 0.6,
	},

	card: {
		backgroundColor: theme.colors.card,
		borderRadius: 12,
		padding: 16,
	},

	infoRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderColor: theme.colors.border,
	},

	label: {
		fontWeight: "600",
	},

	value: {
		opacity: 0.8,
	},

	sectionTitle: {
		fontWeight: "700",
		marginBottom: 10,
	},

	grid: {
		flexDirection: "row",
		flexWrap: "wrap",
	},

	imageBox: {
		width: "30%",
		aspectRatio: 1,
		margin: "1.5%",
	},

	previewImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},

	buttonRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginTop: 10,
	},

	editButton: {
		flex: 1,
		backgroundColor: theme.colors.primary,
		padding: 14,
		borderRadius: 10,
		alignItems: "center",
		marginRight: 6,
		flexDirection: "row",
		justifyContent: "center",
	},

	deleteButton: {
		flex: 1,
		backgroundColor: theme.colors.expense,
		padding: 14,
		borderRadius: 10,
		alignItems: "center",
		marginLeft: 6,
		flexDirection: "row",
		justifyContent: "center",
	},

	buttonText: {
		color: "#fff",
		marginLeft: 6,
		fontWeight: "600",
	},

	modalContainer: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.9)",
		justifyContent: "center",
		alignItems: "center",
	},

	closeButton: {
		position: "absolute",
		top: 50,
		right: 20,
		zIndex: 10,
	},

	fullImage: {
		width: screenWidth,
		height: "80%",
	},
});
