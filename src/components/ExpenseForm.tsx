import React, { useState, useEffect } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	Image,
	Platform,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { File, Directory, Paths } from "expo-file-system";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { styles } from "@screens/AddEntryScreen/AddEntry.styles";
import { theme } from "@theme";
import { expenseCategories } from "@constants/categories";

import {
	addTransaction,
	updateTransaction,
	getDailyTransactionCount,
	checkExpenseSupplierSameDay,
} from "@database/transactionService";

import { getOrCreateSupplier, getSuppliers } from "@database/supplierService";

import { RootStackParamList } from "@navigation/types";
import {
	PAYMENT_OPTIONS,
	PaymentType,
	TransactionInput,
} from "src/types/transaction";

type NavigationProp = NativeStackNavigationProp<RootStackParamList, "AddEntry">;

type Supplier = {
	id: number;
	name: string;
};

type Props = {
	editingTransaction: any;
	isEditMode: boolean;
	onSaveSuccess: () => void;
};

export default function ExpenseForm({
	editingTransaction,
	isEditMode,
	onSaveSuccess,
}: Props) {
	const navigation = useNavigation<NavigationProp>();

	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState("");
	const [supplier, setSupplier] = useState("");
	const [suppliers, setSuppliers] = useState<Supplier[]>([]);
	const [paymentType, setPaymentType] = useState<PaymentType>("cash");
	const [note, setNote] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [selectedDate, setSelectedDate] = useState(new Date());
	const [showDatePicker, setShowDatePicker] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	useEffect(() => {
		const loadSuppliers = async () => {
			const data = await getSuppliers();
			setSuppliers(data as Supplier[]);
		};
		loadSuppliers();
	}, []);

	useEffect(() => {
		if (editingTransaction?.type === "expense") {
			setAmount(String(editingTransaction.amount));
			setCategory(editingTransaction.category ?? "");
			setSupplier(editingTransaction.supplierName ?? "");
			setPaymentType(editingTransaction.paymentType ?? "cash");
			setNote(editingTransaction.note ?? "");
			setSelectedDate(new Date(editingTransaction.date));

			if (editingTransaction.imagePath) {
				setImages(JSON.parse(editingTransaction.imagePath));
			}
		}
	}, [editingTransaction]);

	const pickImage = async () => {
		if (images.length >= 7) {
			alert("Maximum 7 images allowed");
			return;
		}

		const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

		if (!permission.granted) {
			alert("Permission required");
			return;
		}

		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			quality: 0.7,
			allowsMultipleSelection: true,
			selectionLimit: 7 - images.length,
		});

		if (!result.canceled) {
			const billsDir = new Directory(Paths.document, "bills");

			if (!(await billsDir.exists)) {
				await billsDir.create({ intermediates: true });
			}

			const newImagePaths: string[] = [];

			for (const asset of result.assets) {
				const fileName = `bill_${Date.now()}_${Math.random()}.jpg`;
				const newFile = new File(billsDir, fileName);
				const sourceFile = new File(asset.uri);

				await sourceFile.copy(newFile);

				newImagePaths.push(newFile.uri);
			}

			setImages((prev) => [...prev, ...newImagePaths]);
		}
	};

	const handleSave = async () => {
		try {
			if (!amount || !category || !supplier) {
				alert("Amount, Category and Supplier are required");
				return;
			}

			const numericAmount = Number(amount.trim());

			if (
				!Number.isFinite(numericAmount) ||
				numericAmount <= 0 ||
				numericAmount > 20000
			) {
				alert("Enter a valid amount");
				return;
			}

			const formattedDate = formatDate(selectedDate);

			if (!isEditMode) {
				const count = await getDailyTransactionCount(formattedDate, "expense");

				if (count >= 12) {
					alert("Maximum 12 expense entries allowed per day.");
					return;
				}
			}

			const supplierId = await getOrCreateSupplier(supplier);

			const existingSupplier = await checkExpenseSupplierSameDay(
				formattedDate,
				supplierId,
				editingTransaction?.id,
			);

			if (existingSupplier) {
				alert(
					`Expense for supplier "${supplier}" already exists for this date.`,
				);
				return;
			}

			const payload: TransactionInput = {
				type: "expense",
				amount: numericAmount,
				category,
				note: note || null,
				date: formattedDate,
				paymentType,
				supplierId,
				imagePath: images.length > 0 ? JSON.stringify(images) : null,
			};

			if (isEditMode) {
				await updateTransaction(editingTransaction.id, payload);
				onSaveSuccess();
				alert("Transaction Updated");
				navigation.goBack();
			} else {
				await addTransaction(payload);
				alert("Transaction Saved");

				setAmount("");
				setCategory("");
				setSupplier("");
				setNote("");
				setPaymentType("cash");
				setImages([]);
				onSaveSuccess();
			}
		} catch (error) {
			console.log(error);
			alert("Error saving transaction");
		}
	};

	return (
		<>
			{/* DATE */}
			<Text style={styles.label}>Date</Text>
			<TouchableOpacity
				style={styles.input}
				onPress={() => setShowDatePicker(true)}
			>
				<Text>{formatDate(selectedDate)}</Text>
			</TouchableOpacity>

			{showDatePicker && (
				<DateTimePicker
					value={selectedDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, date) => {
						setShowDatePicker(false);
						if (date) setSelectedDate(date);
					}}
				/>
			)}

			{/* AMOUNT */}
			<Text style={styles.label}>Amount</Text>
			<TextInput
				style={styles.amountInput}
				keyboardType="numeric"
				placeholder="₹ 0.00"
				value={amount}
				onChangeText={setAmount}
				placeholderTextColor={theme.colors.textSecondary}
			/>

			{/* CATEGORY */}
			<Text style={styles.label}>Category</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={category}
					onValueChange={(value) => setCategory(value)}
				>
					<Picker.Item label="Select Category" value="" />
					{expenseCategories.map((cat) => (
						<Picker.Item key={cat} label={cat} value={cat} />
					))}
				</Picker>
			</View>

			{/* SUPPLIER */}
			<Text style={styles.label}>Supplier</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={supplier}
					onValueChange={(value) => setSupplier(value)}
				>
					<Picker.Item label="Select Supplier" value="" />
					{suppliers.map((sup) => (
						<Picker.Item key={sup.id} label={sup.name} value={sup.name} />
					))}
				</Picker>
			</View>

			{/* PAYMENT */}
			<Text style={styles.label}>Payment Type</Text>
			<View style={styles.paymentRow}>
				{PAYMENT_OPTIONS.map((p) => (
					<TouchableOpacity
						key={p}
						style={[
							styles.paymentButton,
							paymentType === p && styles.paymentActive,
						]}
						onPress={() => setPaymentType(p)}
					>
						<Text
							style={[
								styles.paymentText,
								{
									color: paymentType === p ? "#fff" : theme.colors.textPrimary,
								},
							]}
						>
							{p.toUpperCase()}
						</Text>
					</TouchableOpacity>
				))}
			</View>

			{/* NOTE */}
			<Text style={styles.label}>Note</Text>
			<TextInput
				style={[styles.input, { height: 80 }]}
				value={note}
				onChangeText={setNote}
				multiline
			/>

			{/* IMAGE PICKER */}
			<TouchableOpacity style={styles.imageButton} onPress={pickImage}>
				<Ionicons name="camera-outline" size={20} color="#fff" />
				<Text style={styles.imageButtonText}>
					Add Bill Images ({images.length}/7)
				</Text>
			</TouchableOpacity>

			<View style={styles.grid}>
				{images.map((img, index) => (
					<View key={index} style={styles.imageBox}>
						<Image source={{ uri: img }} style={styles.previewImage} />

						<TouchableOpacity
							style={styles.removeImageButton}
							onPress={async () => {
								const file = new File(img);
								await file.delete();
								setImages((prev) => prev.filter((_, i) => i !== index));
							}}
						>
							<Ionicons name="close" size={14} color="#fff" />
						</TouchableOpacity>
					</View>
				))}
			</View>

			{/* SAVE */}
			<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
				<Text style={styles.saveButtonText}>
					{isEditMode ? "Update Entry" : "Save Entry"}
				</Text>
			</TouchableOpacity>
		</>
	);
}
